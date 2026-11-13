// MongoDB Atlas client singleton.
//
// A single MongoClient is shared across the agent process. The driver handles
// pooling and reconnects. Call closeMongoClient() at shutdown to release the
// pool.
import { type Db, MongoClient } from 'mongodb';

export const DEFAULT_DB_NAME = 'livekit_mongo_starter';

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (client) {
    return client;
  }
  if (!connectPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI environment variable is not set.');
    }
    const next = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    connectPromise = next.connect().then((connected) => {
      client = connected;
      connectPromise = null;
      return connected;
    });
  }
  return connectPromise;
}

export async function getDb(name?: string): Promise<Db> {
  const c = await getMongoClient();
  return c.db(name ?? process.env.MONGODB_DB ?? DEFAULT_DB_NAME);
}

export async function closeMongoClient(): Promise<void> {
  if (client) {
    const toClose = client;
    client = null;
    await toClose.close();
  }
}
