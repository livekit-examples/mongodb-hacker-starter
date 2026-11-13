// LiveKit voice agent with MongoDB Atlas integration.
//
// Demonstrates five integration patterns:
//   1. RAG with $vectorSearch              -> search_knowledge tool
//   2. Agentic memory tools                -> remember/recall/forget/search_memories
//   3. Identify + pre-load context         -> preload_user (entrypoint)
//   4. Function-tool CRUD                  -> @function_tool methods
//   5. Session report persistence          -> on_session_end
import { llm, voice } from '@livekit/agents';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { getDb } from './db/client.ts';
import { embedText } from './tools/embeddings.ts';
import { forget, listMemories, recall, remember, searchMemory } from './tools/memory.ts';

// Allow-list for identity fields that `update_profile` can write to the
// `users` document. Values are dotted paths so nested preferences work
// without a second tool. Anything outside this map belongs in `memories`.
const PROFILE_PATHS: Record<string, string> = {
  name: 'name',
  email: 'email',
  preferred_language: 'preferences.language',
  timezone: 'preferences.timezone',
};

const INSTRUCTIONS =
  'You are a friendly voice assistant with MongoDB-backed tools. ' +
  'The user is speaking to you, so reply in plain text without ' +
  'markdown, lists, or emojis. Keep replies short. ' +
  'Use lookup_order to retrieve order details by id. ' +
  'Use search_knowledge for any question about voice agents, ' +
  'MongoDB, LiveKit, STT/LLM/TTS providers, session handling, ' +
  'or related topics you are not confident answering from ' +
  'prior context. Call it before answering; the tool itself ' +
  'keeps the user engaged while it runs. ' +
  'When the user tells you their name, email, preferred language, ' +
  'or timezone, call update_profile with the matching field so it ' +
  'persists in their profile. ' +
  'Use remember_detail for any other fact the user volunteers, ' +
  "under a short specific label like 'favorite_color', 'allergy', " +
  "or 'preferred_pronouns'. Each label is a slot and writing a " +
  'new value replaces the old one. Use recall_detail only when ' +
  'you know the exact label; otherwise call search_memories with ' +
  'a natural-language query. Use forget_detail to drop a slot and ' +
  'list_user_memories when the user asks what you remember.';

interface KnowledgeHit {
  title: string;
  content: string;
}

export async function vectorSearchKnowledge(
  db: Db,
  query: string,
  limit = 3,
): Promise<KnowledgeHit[]> {
  const queryEmbedding = await embedText(query, { inputType: 'query' });
  return db
    .collection<KnowledgeHit>('knowledge')
    .aggregate<KnowledgeHit>([
      {
        $vectorSearch: {
          index: 'knowledge_embedding_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit,
        },
      },
      { $project: { title: 1, content: 1, _id: 0 } },
    ])
    .toArray();
}

export interface MongoAgentOptions {
  chatCtx: llm.ChatContext;
  userId: string;
  tenantId: string;
}

export class MongoAgent extends voice.Agent {
  constructor(opts: MongoAgentOptions) {
    const { chatCtx, userId, tenantId } = opts;
    super({
      chatCtx,
      instructions: INSTRUCTIONS,
      tools: MongoAgent.buildTools(userId, tenantId),
    });
  }

  private static buildTools(userId: string, tenantId: string) {
    return {
      lookup_order: llm.tool({
        description: 'Look up an order by its ID. Returns items, total, and status.',
        parameters: z.object({
          order_id: z.string().describe('The order ID to look up.'),
        }),
        execute: async ({ order_id }) => {
          const db = await getDb();
          const order = await db
            .collection<{
              order_id: string;
              items: unknown;
              total: unknown;
              status: string;
            }>('orders')
            .findOne({ order_id });
          if (!order) {
            throw new llm.ToolError(`Order ${order_id} not found.`);
          }
          return JSON.stringify({
            order_id: order.order_id,
            items: order.items,
            total: order.total,
            status: order.status,
          });
        },
      }),

      search_knowledge: llm.tool({
        description:
          'Search the shared knowledge base for facts the user asks about. ' +
          'Use when the user asks a question about voice agents, MongoDB, ' +
          'LiveKit, STT/LLM/TTS providers, session handling, or anything ' +
          'else you are not confident answering from prior context. Returns ' +
          'a JSON object with a `results` array of `{title, content}`.',
        parameters: z.object({
          query: z.string().describe('Natural-language question to search the knowledge base for.'),
        }),
        execute: async ({ query }, { ctx }) => {
          const statusTimer = setTimeout(() => {
            ctx.session.generateReply({
              instructions:
                `You are searching the knowledge base for '${query}' ` +
                'but it is taking a moment. Give the user a brief, ' +
                'one-sentence update that you are looking it up.',
            });
          }, 500);
          try {
            const db = await getDb();
            const results = await vectorSearchKnowledge(db, query, 3);
            return JSON.stringify({ results });
          } finally {
            clearTimeout(statusTimer);
          }
        },
      }),

      update_profile: llm.tool({
        description:
          "Update an identity field on the user's profile. Use for name, " +
          'email, preferred_language, or timezone. These are first-class ' +
          'profile fields stored on the `users` document and loaded at ' +
          'session start. For anything else, use remember_detail.',
        parameters: z.object({
          field: z.string().describe('One of name, email, preferred_language, timezone.'),
          value: z.string().describe('The value to store.'),
        }),
        execute: async ({ field, value }) => {
          const path = PROFILE_PATHS[field];
          if (!path) {
            const allowed = Object.keys(PROFILE_PATHS).sort();
            throw new llm.ToolError(
              `Unknown profile field '${field}'. Allowed: ${JSON.stringify(allowed)}`,
            );
          }
          const db = await getDb();
          const now = new Date();
          await db.collection('users').updateOne(
            { user_id: userId },
            {
              $set: { [path]: value, updated_at: now },
              $setOnInsert: { user_id: userId, created_at: now },
            },
            { upsert: true },
          );
          return `Updated ${field} to ${value}.`;
        },
      }),

      remember_detail: llm.tool({
        description:
          'Store or replace a fact under memory_type. Use for preferences, ' +
          'allergies, pronouns, or anything the user volunteers. Pick a ' +
          "short specific label like 'favorite_color' rather than a generic " +
          "one like 'preferences'.",
        parameters: z.object({
          memory_type: z.string().describe('Short label slot, e.g. favorite_color.'),
          content: z.string().describe('The value to remember.'),
        }),
        execute: async ({ memory_type, content }) => {
          const db = await getDb();
          return remember(db, userId, tenantId, memory_type, content);
        },
      }),

      recall_detail: llm.tool({
        description:
          'Return the value stored under memory_type by exact label. ' +
          "Returns 'No memory found' when the label is not set. Prefer " +
          'search_memories when you are unsure which label stores the fact.',
        parameters: z.object({
          memory_type: z.string().describe('Exact label to recall.'),
        }),
        execute: async ({ memory_type }) => {
          const db = await getDb();
          return recall(db, userId, tenantId, memory_type);
        },
      }),

      forget_detail: llm.tool({
        description: 'Delete the value stored under memory_type.',
        parameters: z.object({
          memory_type: z.string().describe('Exact label to delete.'),
        }),
        execute: async ({ memory_type }) => {
          const db = await getDb();
          return forget(db, userId, tenantId, memory_type);
        },
      }),

      search_memories: llm.tool({
        description:
          'Find memories by meaning using hybrid vector and text search. ' +
          'Use when you do not know the exact label or when pulling ' +
          'background context. Returns a list of {memory_type, content} ' +
          'objects so you can follow up with recall_detail or forget_detail.',
        parameters: z.object({
          query: z.string().describe('Natural-language description.'),
        }),
        execute: async ({ query }) => {
          const db = await getDb();
          const results = await searchMemory(db, userId, tenantId, query, 3);
          return JSON.stringify({ results });
        },
      }),

      list_user_memories: llm.tool({
        description: 'Return every slot stored for this user, newest first.',
        parameters: z.object({}),
        execute: async () => {
          const db = await getDb();
          const results = await listMemories(db, userId, tenantId);
          return JSON.stringify({
            results: results.map((r) => ({
              memory_type: r.memory_type,
              content: r.content,
            })),
          });
        },
      }),
    };
  }
}
