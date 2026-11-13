// Agentic memory tools.
//
// Each function takes a `Db` plus user_id and tenant_id so memories stay
// isolated across users and tenants. Memories are stored as slots keyed by
// (user_id, tenant_id, memory_type) so writing the same label twice replaces
// the previous value. Retrieval combines `$vectorSearch` on the `embedding`
// field and `$search` on `memory_type` + `content` via `$rankFusion`, which
// is why this module requires MongoDB 8.0 or later.
import type { Db } from 'mongodb';
import { embedText } from './embeddings.ts';

interface MemoryScope {
  user_id: string;
  tenant_id: string;
}

interface MemoryResult {
  memory_type: string;
  content: string;
}

interface MemoryListItem extends MemoryResult {
  updated_at: Date;
}

function scope(userId: string, tenantId: string): MemoryScope {
  return { user_id: userId, tenant_id: tenantId };
}

// Voyage's free tier without a payment method caps embeddings at 3 RPM and
// returns 403 once the cap is hit. We don't want a transient embedding
// failure to drop the user's data, so on 403/429 we fall back to writing the
// memory without the vector. Recall/list/forget still work; semantic
// searchMemory degrades to text-only until the cap window resets.
function isEmbeddingRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('(403 ') || msg.includes('(429 ');
}

/**
 * Store or replace the value stored under (user_id, tenant_id, memory_type).
 *
 * The embedding joins the label and the content so short-value slots
 * ("name": "Pavel") stay semantically findable from natural-language queries
 * ("what's the user's name?").
 */
export async function remember(
  db: Db,
  userId: string,
  tenantId: string,
  memoryType: string,
  content: string,
): Promise<string> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(`${memoryType}: ${content}`, {
      inputType: 'document',
    });
  } catch (err) {
    if (!isEmbeddingRateLimited(err)) throw err;
    console.warn(`embedText rate-limited; storing ${memoryType} without vector`);
  }
  const now = new Date();
  const $set: Record<string, unknown> = { content, updated_at: now };
  if (embedding) {
    $set.embedding = embedding;
  }
  const $unset = embedding ? undefined : { embedding: '' };
  const update: Record<string, unknown> = {
    $set,
    $setOnInsert: { created_at: now },
  };
  if ($unset) update.$unset = $unset;
  await db
    .collection('memories')
    .updateOne({ ...scope(userId, tenantId), memory_type: memoryType }, update, { upsert: true });
  return `Remembered (${memoryType}): ${content}`;
}

/** Return the value stored under memory_type, or a 'no memory' message. */
export async function recall(
  db: Db,
  userId: string,
  tenantId: string,
  memoryType: string,
): Promise<string> {
  const memory = await db
    .collection<{ content: string }>('memories')
    .findOne({ ...scope(userId, tenantId), memory_type: memoryType });
  return memory ? memory.content : 'No memory found.';
}

/** Delete the value stored under memory_type. */
export async function forget(
  db: Db,
  userId: string,
  tenantId: string,
  memoryType: string,
): Promise<string> {
  const result = await db
    .collection('memories')
    .deleteOne({ ...scope(userId, tenantId), memory_type: memoryType });
  if (result.deletedCount === 0) {
    return 'No memory to forget.';
  }
  return 'Memory forgotten.';
}

/**
 * Hybrid vector + text search over the user's memories.
 *
 * Uses `$rankFusion` (MongoDB 8.0+) to combine cosine similarity on the
 * content embedding with lexical fuzzy matching on `memory_type` and
 * `content`. The vector branch carries semantic intent; the text branch
 * catches literal label hits like "what's my user_name?" that pure vector
 * search can miss on short values.
 */
export async function searchMemory(
  db: Db,
  userId: string,
  tenantId: string,
  query: string,
  limit = 5,
): Promise<MemoryResult[]> {
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedText(query, { inputType: 'query' });
  } catch (err) {
    if (!isEmbeddingRateLimited(err)) throw err;
    console.warn('embedText rate-limited; falling back to text-only search');
  }
  const memoryScope = scope(userId, tenantId);
  const textSearchStage = [
    {
      $search: {
        index: 'memories_text_index',
        compound: {
          should: [
            { text: { query, path: 'memory_type', fuzzy: {} } },
            { text: { query, path: 'content', fuzzy: {} } },
          ],
        },
      },
    },
    { $match: memoryScope },
    { $limit: limit },
    { $project: { _id: 0, memory_type: 1, content: 1 } },
  ];
  if (!queryEmbedding) {
    return db
      .collection<MemoryResult>('memories')
      .aggregate<MemoryResult>(textSearchStage)
      .toArray();
  }
  const pipeline = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vectorSearch: [
              {
                $vectorSearch: {
                  index: 'memories_embedding_index',
                  path: 'embedding',
                  queryVector: queryEmbedding,
                  numCandidates: 100,
                  limit: 30,
                  filter: memoryScope,
                },
              },
            ],
            textSearch: [
              {
                $search: {
                  index: 'memories_text_index',
                  compound: {
                    should: [
                      { text: { query, path: 'memory_type', fuzzy: {} } },
                      { text: { query, path: 'content', fuzzy: {} } },
                    ],
                  },
                },
              },
              { $match: memoryScope },
              { $limit: 30 },
            ],
          },
        },
        combination: {
          weights: { vectorSearch: 0.7, textSearch: 0.3 },
        },
      },
    },
    { $limit: limit },
    { $project: { _id: 0, memory_type: 1, content: 1 } },
  ];
  return db.collection<MemoryResult>('memories').aggregate<MemoryResult>(pipeline).toArray();
}

/** Return every slot stored for this (user_id, tenant_id), newest first. */
export async function listMemories(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<MemoryListItem[]> {
  return db
    .collection<MemoryListItem>('memories')
    .find(scope(userId, tenantId), {
      projection: { _id: 0, memory_type: 1, content: 1, updated_at: 1 },
      sort: { updated_at: -1 },
    })
    .toArray();
}
