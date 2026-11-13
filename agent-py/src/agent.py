"""LiveKit voice agent with MongoDB Atlas integration.

Demonstrates five integration patterns:

1. RAG with $vectorSearch              -> search_knowledge tool
2. Agentic memory tools                -> remember/recall/forget/search_memories
3. Identify + pre-load context         -> preload_user (entrypoint)
4. Function-tool CRUD                  -> @function_tool methods
5. Session report persistence          -> on_session_end
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ChatContext,
    JobContext,
    RunContext,
    ToolError,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from db.client import aclose, get_db
from tools.embeddings import embed_text
from tools.memory import forget, list_memories, recall, remember, search_memory

load_dotenv(".env.local")

logger = logging.getLogger("agent")

# Fallback identity used only when ctx.job.metadata is absent, e.g. when
# running `uv run src/agent.py console`. The frontend always provides a
# real per-browser user_id via agent dispatch metadata.
DEFAULT_USER_ID = "user_1"
DEFAULT_TENANT_ID = "default"

# Allow-list for identity fields that `update_profile` can write to the
# `users` document. Values are dotted paths so nested preferences work
# without a second tool. Anything outside this map belongs in `memories`.
_PROFILE_PATHS = {
    "name": "name",
    "email": "email",
    "preferred_language": "preferences.language",
    "timezone": "preferences.timezone",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _vector_search_knowledge(
    db: AsyncDatabase, query: str, limit: int = 3
) -> list[dict]:
    """Run the shared knowledge vector search and return {title, content} docs."""
    query_embedding = await embed_text(query, input_type="query")
    pipeline = [
        {
            "$vectorSearch": {
                "index": "knowledge_embedding_index",
                "path": "embedding",
                "queryVector": query_embedding,
                "numCandidates": 100,
                "limit": limit,
            }
        },
        {"$project": {"title": 1, "content": 1, "_id": 0}},
    ]
    cursor = await db.knowledge.aggregate(pipeline)
    return await cursor.to_list(length=limit)


class MongoAgent(Agent):
    """Voice agent that wires MongoDB Atlas into the LiveKit pipeline."""

    def __init__(
        self, *, chat_ctx: ChatContext, user_id: str, tenant_id: str
    ) -> None:
        super().__init__(
            chat_ctx=chat_ctx,
            instructions=(
                "You are a friendly voice assistant with MongoDB-backed tools. "
                "The user is speaking to you, so reply in plain text without "
                "markdown, lists, or emojis. Keep replies short. "
                "Use lookup_order to retrieve order details by id. "
                "Use search_knowledge for any question about voice agents, "
                "MongoDB, LiveKit, STT/LLM/TTS providers, session handling, "
                "or related topics you are not confident answering from "
                "prior context. Call it before answering; the tool itself "
                "keeps the user engaged while it runs. "
                "When the user tells you their name, email, preferred language, "
                "or timezone, call update_profile with the matching field so it "
                "persists in their profile. "
                "Use remember_detail for any other fact the user volunteers, "
                "under a short specific label like 'favorite_color', 'allergy', "
                "or 'preferred_pronouns'. Each label is a slot and writing a "
                "new value replaces the old one. Use recall_detail only when "
                "you know the exact label; otherwise call search_memories with "
                "a natural-language query. Use forget_detail to drop a slot and "
                "list_user_memories when the user asks what you remember."
            ),
        )
        self._user_id = user_id
        self._tenant_id = tenant_id

    async def on_enter(self) -> None:
        await self.session.generate_reply(
            instructions=(
                "Greet the user by name if the loaded profile or remembered "
                "facts contain one. If no name is on file, briefly introduce "
                "yourself as a MongoDB-backed voice assistant and ask the "
                "user for their name. When they tell you, call update_profile "
                "with field='name' so it persists for next time."
            )
        )

    @function_tool()
    async def lookup_order(self, context: RunContext, order_id: str) -> str:
        """Look up an order by its ID. Returns items, total, and status."""
        db = await get_db()
        order = await db.orders.find_one({"order_id": order_id})
        if not order:
            raise ToolError(f"Order {order_id} not found.")
        return json.dumps(
            {
                "order_id": order["order_id"],
                "items": order["items"],
                "total": order["total"],
                "status": order["status"],
            }
        )

    @function_tool()
    async def search_knowledge(
        self, context: RunContext, query: str
    ) -> str:
        """Search the shared knowledge base for facts the user asks about.

        Use when the user asks a question about voice agents, MongoDB,
        LiveKit, STT/LLM/TTS providers, session handling, or anything
        else you are not confident answering from prior context. Returns
        a JSON object with a `results` array of `{title, content}`.
        """

        async def _speak_status_update(delay: float = 0.5) -> None:
            await asyncio.sleep(delay)
            await context.session.generate_reply(
                instructions=(
                    f"You are searching the knowledge base for '{query}' "
                    "but it is taking a moment. Give the user a brief, "
                    "one-sentence update that you are looking it up."
                )
            )

        status_task = asyncio.create_task(_speak_status_update(0.5))
        try:
            db = await get_db()
            results = await _vector_search_knowledge(db, query, limit=3)
        finally:
            status_task.cancel()
        return json.dumps({"results": results})

    @function_tool()
    async def update_profile(
        self, context: RunContext, field: str, value: str
    ) -> str:
        """Update an identity field on the user's profile.

        Use for name, email, preferred_language, or timezone. These are
        first-class profile fields stored on the `users` document and
        loaded at session start. For anything else, use remember_detail.
        """
        if field not in _PROFILE_PATHS:
            raise ToolError(
                f"Unknown profile field '{field}'. "
                f"Allowed: {sorted(_PROFILE_PATHS)}"
            )
        db = await get_db()
        now = _now()
        await db.users.update_one(
            {"user_id": self._user_id},
            {
                "$set": {_PROFILE_PATHS[field]: value, "updated_at": now},
                "$setOnInsert": {
                    "user_id": self._user_id,
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return f"Updated {field} to {value}."

    @function_tool()
    async def remember_detail(
        self, context: RunContext, memory_type: str, content: str
    ) -> str:
        """Store or replace a fact under memory_type.

        Use for preferences, allergies, pronouns, or anything the user
        volunteers. Pick a short specific label like 'favorite_color'
        rather than a generic one like 'preferences'.
        """
        db = await get_db()
        return await remember(
            db, self._user_id, self._tenant_id, memory_type, content
        )

    @function_tool()
    async def recall_detail(
        self, context: RunContext, memory_type: str
    ) -> str:
        """Return the value stored under memory_type by exact label.

        Returns 'No memory found' when the label is not set. Prefer
        search_memories when you are unsure which label stores the fact.
        """
        db = await get_db()
        return await recall(db, self._user_id, self._tenant_id, memory_type)

    @function_tool()
    async def forget_detail(
        self, context: RunContext, memory_type: str
    ) -> str:
        """Delete the value stored under memory_type."""
        db = await get_db()
        return await forget(db, self._user_id, self._tenant_id, memory_type)

    @function_tool()
    async def search_memories(self, context: RunContext, query: str) -> str:
        """Find memories by meaning using hybrid vector and text search.

        Use when you do not know the exact label or when pulling
        background context. Returns a list of {memory_type, content}
        objects so you can follow up with recall_detail or forget_detail.
        """
        db = await get_db()
        results = await search_memory(
            db, self._user_id, self._tenant_id, query, limit=3
        )
        return json.dumps({"results": results})

    @function_tool()
    async def list_user_memories(self, context: RunContext) -> str:
        """Return every slot stored for this user, newest first."""
        db = await get_db()
        results = await list_memories(db, self._user_id, self._tenant_id)
        return json.dumps(
            {
                "results": [
                    {"memory_type": r["memory_type"], "content": r["content"]}
                    for r in results
                ]
            }
        )


async def preload_user(user_id: str, tenant_id: str) -> ChatContext:
    """Pattern 3: load user data into the chat context before the session.

    Upserts the `users` row so every connected user (including anonymous
    cookie visitors) has a stable profile document, then appends any
    memory slots the agent has learned for this (user_id, tenant_id) in
    prior sessions. Both writes land as assistant messages so the LLM
    sees them before the first reply.
    """
    db = await get_db()
    now = _now()
    user = await db.users.find_one_and_update(
        {"user_id": user_id},
        {
            "$set": {"last_seen_at": now},
            "$setOnInsert": {"user_id": user_id, "created_at": now},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )

    chat_ctx = ChatContext()
    name = user.get("name")
    email = user.get("email")
    prefs = user.get("preferences", {})
    if name or email or prefs:
        chat_ctx.add_message(
            role="assistant",
            content=(
                f"User profile: name={name or 'unknown'}, "
                f"email={email or 'unknown'}, preferences={prefs}."
            ),
        )
    else:
        chat_ctx.add_message(
            role="assistant",
            content=(
                f"No stored profile fields yet for user_id {user_id}. "
                "Greet them as a new user, then ask for their name and "
                "call update_profile with field='name' so it persists."
            ),
        )
    if not name:
        chat_ctx.add_message(
            role="assistant",
            content=(
                "No name on file for this user. Ask them for their name "
                "and call update_profile with field='name' to save it."
            ),
        )

    memories = await list_memories(db, user_id, tenant_id)
    if memories:
        lines = "\n".join(
            f"- {m['memory_type']}: {m['content']}" for m in memories
        )
        chat_ctx.add_message(
            role="assistant",
            content=f"Remembered facts from prior sessions:\n{lines}",
        )
    return chat_ctx


async def on_session_end(ctx: JobContext) -> None:
    """Pattern 5: persist a session report to MongoDB on hangup."""
    try:
        report = ctx.make_session_report()
        db = await get_db()
        user_id = ctx.proc.userdata.get("user_id", DEFAULT_USER_ID)
        tenant_id = ctx.proc.userdata.get("tenant_id", DEFAULT_TENANT_ID)
        await db.sessions.insert_one(
            {
                "session_id": ctx.room.name,
                "user_id": user_id,
                "tenant_id": tenant_id,
                "room_name": ctx.room.name,
                "report": report.to_dict(),
            }
        )
        logger.info("Persisted session report for %s", ctx.room.name)
    except Exception:
        logger.exception("Failed to persist session report")
    finally:
        await aclose()


server = AgentServer()


@server.rtc_session(agent_name="my-agent", on_session_end=on_session_end)
async def my_agent(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    # Pattern 3 setup: identify the user from agent dispatch metadata.
    # The frontend packs {"user_id", "tenant_id"} into ctx.job.metadata via
    # room_config.agents[0].metadata. Parsing here (before ctx.connect) keeps
    # the preload network call out of the connection critical path. See:
    # https://docs.livekit.io/agents/logic/external-data/
    meta: dict[str, str] = {}
    if ctx.job.metadata:
        try:
            meta = json.loads(ctx.job.metadata)
        except json.JSONDecodeError:
            logger.warning("ctx.job.metadata was not valid JSON; using defaults")

    user_id = meta.get("user_id", DEFAULT_USER_ID)
    tenant_id = meta.get("tenant_id", DEFAULT_TENANT_ID)
    ctx.proc.userdata["user_id"] = user_id
    ctx.proc.userdata["tenant_id"] = tenant_id

    initial_ctx = await preload_user(user_id, tenant_id)

    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        llm=inference.LLM(model="openai/gpt-5.3-chat-latest"),
        tts=inference.TTS(
            model="cartesia/sonic-3", voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
        ),
        turn_handling=TurnHandlingOptions(
            # LiveKit's audio turn detector: predicts end of turn from the user's
            # audio (semantics plus intonation and pacing). AgentSession supplies
            # the VAD it needs automatically.
            # See https://docs.livekit.io/agents/logic/turns/turn-detector/
            turn_detection=inference.TurnDetector(),
            preemptive_generation={"enabled": True},
        ),
    )

    await session.start(
        agent=MongoAgent(
            chat_ctx=initial_ctx,
            user_id=user_id,
            tenant_id=tenant_id,
        ),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=ai_coustics.audio_enhancement(
                    model=ai_coustics.EnhancerModel.QUAIL_VF_L
                ),
            ),
        ),
    )

    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
