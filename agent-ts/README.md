# LiveKit + MongoDB Atlas Voice Agent (Node.js)

A voice AI agent built on the [LiveKit Agents Node.js starter](https://github.com/livekit-examples/agent-starter-node) and wired into [MongoDB Atlas](https://www.mongodb.com/atlas) to demonstrate five integration patterns:

1. **Pre-load context at session start** — load the user profile from MongoDB into the chat context before the agent speaks.
2. **Function-tool CRUD** — `llm.tool` definitions that read and write MongoDB documents.
3. **RAG with `$vectorSearch` on every turn** — embed the user message, run an aggregation against an Atlas vector index, and inject the top hits into the chat context inside `onUserTurnCompleted`.
4. **Session report persistence** — write the structured `SessionReport` to MongoDB inside `addShutdownCallback`.
5. **Agentic memory tools** — `remember_detail`, `recall_detail`, `forget_detail`, `search_memories`, and `list_user_memories` tools backed by a per-user memory store. Memory is modeled as slots (one value per `(user_id, tenant_id, memory_type)`), and retrieval uses `$rankFusion` to combine `$vectorSearch` and `$search` for hybrid semantic + lexical matching.

The voice pipeline uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/) (Deepgram Nova-3 STT, GPT-5.3 LLM, Cartesia Sonic-3 TTS), the LiveKit [audio turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) (built into the SDK; `AgentSession` supplies its VAD), and ai-coustics noise cancellation. Embeddings are produced by [Voyage AI](https://www.voyageai.com/) (`voyage-3.5-lite`, 1024 dimensions).

## What's in this directory

```
agent-ts/
├── src/
│   ├── main.ts            # defineAgent + entry + cli.runApp
│   ├── agent.ts           # MongoAgent class + 8 tools + onEnter
│   ├── preload.ts         # Pattern 3: profile + memory pre-load
│   ├── db/
│   │   ├── client.ts      # MongoClient singleton
│   │   ├── indexes.ts     # Create collections + vector/text indexes (run once)
│   │   └── seed.ts        # Insert sample users, orders, and knowledge docs
│   └── tools/
│       ├── embeddings.ts  # Voyage AI helper (embedText, embedTexts)
│       └── memory.ts      # remember/recall/forget/searchMemory/listMemories
├── tests/                 # vitest integration tests + Voyage smoke test
├── package.json
└── Dockerfile
```

## Prerequisites

- Node 24+ and [pnpm](https://pnpm.io/) 10+ (the agent runs its TypeScript directly with Node's type stripping; there is no build step)
- [LiveKit CLI](https://docs.livekit.io/reference/developer-tools/livekit-cli/) 2.19 or later (`lk`)
- MongoDB Atlas cluster on **MongoDB 8.0 or later** — required for the `$rankFusion` hybrid retrieval pipeline in `tools/memory.searchMemory`. M10+ dedicated clusters run 8.0 by default; check your cluster's server version in the Atlas UI before running `pnpm db:init` if you are on a shared-tier (M0/M2/M5) cluster.
- LiveKit Cloud project
- Voyage AI API key — [free tier](https://www.voyageai.com/pricing) covers prototypes

## Setup

The fastest path is to bootstrap with the LiveKit CLI:

```bash
lk cloud auth
lk app create my-agent --template agent-starter-node
```

If you cloned this repo directly:

```bash
cd agent-ts
pnpm install
cp .env.example .env.local
# fill in LIVEKIT_*, MONGODB_URI, VOYAGE_API_KEY in .env.local
pnpm download-files   # one-time: plugin model files
```

You can populate `LIVEKIT_*` with `lk app env -w -d .env.local` if you've authenticated with `lk cloud auth`.

## Initialize MongoDB

The DB-setup scripts are hoisted to the repo root so they're shared with the Python sibling. From the repo root, run once after configuring `MONGODB_URI`:

```bash
pnpm db:init   # creates collections and vector + text search indexes
pnpm db:seed   # inserts sample users, orders, and knowledge docs
```

These scripts live at `../db/indexes.ts` and `../db/seed.ts`; the seed data is in `../db/lib/data.ts`. The vector and Atlas Search indexes need ~1-2 minutes to become queryable on Atlas after creation.

## Run the agent

```bash
pnpm console # speak to it in your terminal (`lk agent console`)
pnpm dev     # run for use with the frontend (`lk agent dev --deployment local-dev`)
pnpm start   # production mode (`node src/main.ts start`, what the Dockerfile runs)
```

## Tests

```bash
pnpm test
```

The integration tests provision a fresh Atlas database per test, exercise all five patterns end-to-end, and tear the database down. The Voyage embeddings call is stubbed with deterministic sha256-derived vectors so the suite stays inside the free-tier rate limit; one optional test (`voyage_returns_correct_dimensions` in `tests/voyage.test.ts`) makes a real call to verify the SDK and model dimensions, gated on `VOYAGE_API_KEY`.

The full suite skips when `MONGODB_URI` is not set.

## Frontend

The companion React frontend (built from [`agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)) lives in `../frontend`. To wire it up:

```bash
cd ../frontend
pnpm install
pnpm dev
```

Both apps share the same LiveKit credentials. The frontend dispatches to whichever agent registers under `AGENT_NAME` (default `my-agent`). This Node agent and the Python sibling at `../agent-py` both register under the name `my-agent`, so **only run one of them at a time**. Either:

- Stop the Python agent's `lk agent dev` process before running `pnpm dev` here, or
- Change `agentName: "my-agent"` in `src/main.ts` and `AGENT_NAME` in `../frontend/.env.local` to a different name to run them side by side.

`lk agent dev` registers the agent under a [deployment](https://docs.livekit.io/deploy/agents/deployments/), a random `dev-…` name unless you pass one. The frontend's token route dispatches to `AGENT_DEPLOYMENT` (default `local-dev`), which is why `pnpm dev` passes `--deployment local-dev`. For an agent running as production (`pnpm start`, Docker, LiveKit Cloud), set `AGENT_DEPLOYMENT=` (empty) in `../frontend/.env.local`.

## Who is the user?

Every MongoDB read and write in the agent is scoped by `user_id` and `tenant_id`. The Next.js token route mints a server-minted httpOnly cookie on first visit, stamps the id onto [agent dispatch metadata](https://docs.livekit.io/agents/server/agent-dispatch/), and LiveKit forwards the metadata string to `ctx.job.metadata`:

```ts
const meta = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
const userId = meta.user_id ?? 'user_1';
const tenantId = meta.tenant_id ?? 'default';
```

`main.ts` parses the metadata before `ctx.connect()` so `preloadUser` runs in parallel with the room connection. See the LiveKit [external data guide](https://docs.livekit.io/agents/logic/external-data/) for why this ordering matters.

The resolved values are also stashed on `ctx.proc.userData` so the shutdown callback can write the session report under the correct user id.

## Collection layout

| Collection  | Purpose                                          | Indexes                                                                                                                                                                 |
| ----------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`     | User profiles loaded at session start            | `user_id` (unique)                                                                                                                                                      |
| `orders`    | Sample CRUD target for `lookup_order`            | `order_id` (unique), `user_id`                                                                                                                                          |
| `knowledge` | RAG corpus                                       | `knowledge_embedding_index` ($vectorSearch, 1024 dims, cosine)                                                                                                          |
| `memories`  | Agentic memory store                             | `(user_id, tenant_id, memory_type)` unique; `memories_embedding_index` ($vectorSearch with filter fields); `memories_text_index` ($search on `memory_type` + `content`) |
| `sessions`  | Session reports written by the shutdown callback | `session_id` (unique), `user_id`                                                                                                                                        |

## Customizing for your domain

This is intentionally minimal. To adapt it:

- Swap `users`/`orders`/`knowledge` for your own collections in `../db/indexes.ts` (schema + indexes) and `../db/lib/data.ts` (seed values).
- Add or remove `llm.tool` definitions on `MongoAgent` in `src/agent.ts`.
- Adjust the agent's `instructions` constant to match your domain.
- Change the embedding model in `src/tools/embeddings.ts` (e.g., `voyage-3-large` for higher quality, or `voyage-multilingual-2` for non-English content). Update `EMBEDDING_DIMENSIONS` in `../db/lib/voyage.ts` to match, then re-run `pnpm db:init` so the vector index dimension is rebuilt.

## License

MIT
