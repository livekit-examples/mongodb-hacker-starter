// Per-test database fixture, ported from `code/agent/tests/conftest.py`.
//
// Each test gets a fresh database (timestamp-suffixed name) seeded with a
// known user, order, and a couple of knowledge documents. Setting
// MONGODB_DB before the agent's getDb() runs routes all reads through the
// per-test database. The DB is dropped in cleanup.
import { type Db, MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';

const FAKE_DIMENSIONS = 1024;

export function fakeVector(text: string, dimensions = FAKE_DIMENSIONS): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  const repeated = Buffer.alloc(dimensions);
  for (let i = 0; i < dimensions; i++) {
    repeated[i] = digest[i % digest.length]!;
  }
  const raw = Array.from(repeated, (b) => (b - 128) / 128.0);
  const norm = Math.sqrt(raw.reduce((acc, x) => acc + x * x, 0)) || 1;
  return raw.map((x) => x / norm);
}

function uniqueDbName(): string {
  // Atlas caps database names at 38 bytes
  return `lkmt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export interface SeededDbContext {
  db: Db;
  client: MongoClient;
  cleanup: () => Promise<void>;
}

/** Creates a fresh per-test db and seeds a known user/order/knowledge set. */
export async function seededDb(): Promise<SeededDbContext> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI not set — cannot create test database.');
  }

  const dbName = uniqueDbName();
  process.env.MONGODB_DB = dbName;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  await db.collection('users').createIndex({ user_id: 1 }, { unique: true });
  await db.collection('orders').createIndex({ order_id: 1 }, { unique: true });

  const now = new Date();
  await db.collection('users').insertOne({
    user_id: 'user_1',
    name: 'Jordan',
    email: 'jordan@example.com',
    preferences: { language: 'en' },
    created_at: now,
  });
  await db.collection('orders').insertOne({
    user_id: 'user_1',
    order_id: 'order_1001',
    items: ['Widget A', 'Widget B'],
    total: 49.99,
    status: 'delivered',
    created_at: now,
  });

  const knowledgeInputs = [
    { title: 'RAG pattern', content: 'Inject vector search results into chat context.' },
    { title: 'Memory pattern', content: 'Use tools to remember and recall details.' },
  ];
  await db.collection('knowledge').insertMany(
    knowledgeInputs.map((k) => ({
      ...k,
      embedding: fakeVector(k.content),
      created_at: now,
    })),
  );

  return {
    db,
    client,
    cleanup: async () => {
      try {
        await client.db(dbName).dropDatabase();
      } finally {
        await client.close();
        delete process.env.MONGODB_DB;
      }
    },
  };
}

/**
 * MongoDB throws this when querying a vector or text search index that
 * isn't synced yet. Per-test databases hit this; tests should treat the
 * pipeline call as a sanity check on shape rather than retrieval semantics.
 */
export function isOperationFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'MongoServerError' || name === 'OperationFailure';
}
