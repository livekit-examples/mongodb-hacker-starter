// Pattern 3: load user data into the chat context before the session.
//
// Upserts the `users` row so every connected user (including anonymous cookie
// visitors) has a stable profile document, then appends any memory slots the
// agent has learned for this (user_id, tenant_id) in prior sessions. Both
// writes land as assistant messages so the LLM sees them before the first
// reply.
import { llm } from '@livekit/agents';
import { getDb } from './db/client.ts';
import { listMemories } from './tools/memory.ts';

interface UserDoc {
  user_id: string;
  name?: string;
  email?: string;
  preferences?: Record<string, unknown>;
  created_at?: Date;
  last_seen_at?: Date;
}

export async function preloadUser(userId: string, tenantId: string): Promise<llm.ChatContext> {
  const db = await getDb();
  const now = new Date();
  const user = await db.collection<UserDoc>('users').findOneAndUpdate(
    { user_id: userId },
    {
      $set: { last_seen_at: now },
      $setOnInsert: { user_id: userId, created_at: now },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const chatCtx = new llm.ChatContext();
  const name = user?.name;
  const email = user?.email;
  const prefs = user?.preferences ?? {};
  const hasProfile = Boolean(name) || Boolean(email) || Object.keys(prefs).length > 0;

  if (hasProfile) {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        `User profile: name=${name ?? 'unknown'}, ` +
        `email=${email ?? 'unknown'}, preferences=${JSON.stringify(prefs)}.`,
    });
  } else {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        `No stored profile fields yet for user_id ${userId}. ` +
        'Greet them as a new user, then ask for their name and ' +
        "call update_profile with field='name' so it persists.",
    });
  }
  if (!name) {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        'No name on file for this user. Ask them for their name ' +
        "and call update_profile with field='name' to save it.",
    });
  }

  const memories = await listMemories(db, userId, tenantId);
  if (memories.length > 0) {
    const lines = memories.map((m) => `- ${m.memory_type}: ${m.content}`).join('\n');
    chatCtx.addMessage({
      role: 'assistant',
      content: `Remembered facts from prior sessions:\n${lines}`,
    });
  }

  return chatCtx;
}
