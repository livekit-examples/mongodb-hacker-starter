# LiveKit + MongoDB Atlas Voice Agent (Python)

A voice AI agent built on the [LiveKit Agents Python starter](https://github.com/livekit-examples/agent-starter-python) and wired into [MongoDB Atlas](https://www.mongodb.com/atlas) to demonstrate five integration patterns:

1. **Pre-load context at session start** — load the user profile from MongoDB into the chat context before the agent speaks.
2. **Function-tool CRUD** — `@function_tool` methods that read and write MongoDB documents.
3. **RAG with `$vectorSearch` on every turn** — embed the user message, run an aggregation against an Atlas vector index, and inject the top hits into the chat context inside `on_user_turn_completed`.
4. **Session report persistence** — write the structured `SessionReport` to MongoDB inside `on_session_end`.
5. **Agentic memory tools** — `remember_detail`, `recall_detail`, `forget_detail`, `search_memories`, and `list_user_memories` tools backed by a per-user memory store. Memory is modeled as slots (one value per `(user_id, tenant_id, memory_type)`), and retrieval uses `$rankFusion` to combine `$vectorSearch` and `$search` for hybrid semantic + lexical matching.

The voice pipeline uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/) (Deepgram Nova-3 STT, GPT-5.3 LLM, Cartesia Sonic-3 TTS), the LiveKit [audio turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) (built into the SDK; `AgentSession` supplies its VAD), and ai-coustics noise cancellation. Embeddings are produced by [Voyage AI](https://www.voyageai.com/) (`voyage-3.5-lite`, 1024 dimensions).

## What's in this directory

```
agent-py/
├── src/
│   ├── agent.py           # MongoAgent + entrypoint + on_session_end
│   ├── db/
│   │   ├── client.py      # PyMongo AsyncMongoClient singleton
│   │   ├── indexes.py     # Create collections + vector indexes (run once)
│   │   └── seed.py        # Insert sample users, orders, and knowledge docs
│   └── tools/
│       ├── embeddings.py  # Voyage AI helper (embed_text, embed_texts)
│       └── memory.py      # remember/recall/forget/search_memory/list_memories
├── tests/                 # MongoDB integration tests + Voyage smoke test
├── pyproject.toml
└── Dockerfile
```

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- MongoDB Atlas cluster on **MongoDB 8.0 or later** — required for the `$rankFusion` hybrid retrieval pipeline in `tools/memory.search_memory`. M10+ dedicated clusters run 8.0 by default; check your cluster's server version in the Atlas UI before running `db/indexes.py` if you are on a shared-tier (M0/M2/M5) cluster.
- LiveKit Cloud project
- Voyage AI API key — [free tier](https://www.voyageai.com/pricing) covers prototypes

## Setup

The fastest path is to bootstrap with the LiveKit CLI:

```bash
lk cloud auth
lk app create my-agent --template agent-starter-python
```

If you cloned this repo directly:

```bash
cd agent
uv sync
cp .env.example .env.local
# fill in LIVEKIT_*, MONGODB_URI, VOYAGE_API_KEY in .env.local
uv run -m livekit.agents download-files   # one-time: plugin model files
```

You can populate `LIVEKIT_*` with `lk app env -w -d .env.local` if you've authenticated with `lk cloud auth`.

## Initialize MongoDB

The DB-setup scripts are hoisted to the repo root so they're shared with the Node sibling. From the repo root, run once after configuring `MONGODB_URI`:

```bash
pnpm db:init   # creates collections and vector + text search indexes
pnpm db:seed   # inserts sample users, orders, and knowledge docs
```

These scripts live at `../db/indexes.ts` and `../db/seed.ts`; the seed data is in `../db/lib/data.ts`. The vector indexes need ~1-2 minutes to become queryable on Atlas after creation.

## Run the agent

```bash
uv run src/agent.py console     # speak to it in your terminal
uv run src/agent.py dev         # run for use with a frontend
uv run src/agent.py start       # production mode
```

## Tests

```bash
uv run pytest
```

The integration tests provision a fresh Atlas database per test, exercise all five patterns end-to-end, and tear the database down. The Voyage embeddings call is stubbed with deterministic fake vectors during tests so the suite stays inside the free-tier rate limit; one explicit test (`test_voyage_client_returns_correct_dimensions`) makes a real call to verify the SDK and model dimensions.

## Frontend

The companion React frontend (built from [`agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)) lives in `../frontend`. To wire it up:

```bash
cd ../frontend
pnpm install
pnpm dev
```

Both apps share the same LiveKit credentials. The frontend dispatches to the agent registered as `my-agent`. To use a different name, update `agent_name="my-agent"` in `src/agent.py` and `AGENT_NAME` in `../frontend/.env.local`.

## Who is the user?

Every MongoDB read and write in the agent is scoped by `user_id` and `tenant_id`. The Next.js token route mints a server-minted httpOnly cookie on first visit, stamps the id onto [agent dispatch metadata](https://docs.livekit.io/agents/server/agent-dispatch/), and LiveKit forwards the metadata string to `ctx.job.metadata`:

```python
meta = json.loads(ctx.job.metadata) if ctx.job.metadata else {}
user_id = meta.get("user_id", DEFAULT_USER_ID)
tenant_id = meta.get("tenant_id", DEFAULT_TENANT_ID)
```

`my_agent` parses the metadata before `ctx.connect()` so `preload_user` runs in parallel with the room connection. See the LiveKit [external data guide](https://docs.livekit.io/agents/logic/external-data/) for why this ordering matters.

The resolved values are also stashed on `ctx.proc.userdata` so `on_session_end` can write the session report under the correct user id.

Console mode (`uv run src/agent.py console`) has no frontend, so both fields fall back to the `DEFAULT_*` constants and the seeded `user_1` profile.

## Collection layout

| Collection | Purpose | Indexes |
| --- | --- | --- |
| `users` | User profiles loaded at session start | `user_id` (unique) |
| `orders` | Sample CRUD target for `lookup_order` | `order_id` (unique), `user_id` |
| `knowledge` | RAG corpus | `knowledge_embedding_index` ($vectorSearch, 1024 dims, cosine) |
| `memories` | Agentic memory store | `(user_id, tenant_id, memory_type)` unique; `memories_embedding_index` ($vectorSearch with filter fields); `memories_text_index` ($search on `memory_type` + `content`) |
| `sessions` | Session reports written by `on_session_end` | `session_id` (unique), `user_id` |

## Customizing for your domain

This is intentionally minimal. To adapt it:

- Swap `users`/`orders`/`knowledge` for your own collections in `db/indexes.py` and `db/seed.py`.
- Add or remove `@function_tool` methods on `MongoAgent` in `src/agent.py`.
- Adjust the agent's `instructions` to match your domain.
- Change the embedding model in `src/tools/embeddings.py` (e.g., `voyage-3-large` for higher quality, or `voyage-multilingual-2` for non-English content). Update the `numDimensions` in `db/indexes.py` to match.

## License

MIT
