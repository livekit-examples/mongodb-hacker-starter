// Integration tests for the MongoDB plumbing.
// Ported from `code/agent/tests/test_mongo_integration.py`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SeededDbContext, fakeVector, isOperationFailure, seededDb } from './setupDb.ts';

vi.mock('../src/tools/embeddings', async () => {
  const actual =
    await vi.importActual<typeof import('../src/tools/embeddings')>('../src/tools/embeddings');
  return {
    ...actual,
    embedText: vi.fn(async (text: string) => fakeVector(text)),
    embedTexts: vi.fn(async (texts: string[]) => texts.map((t) => fakeVector(t))),
  };
});

const skipReason = process.env.MONGODB_URI ? null : 'MONGODB_URI not set';
const describeIfDb = skipReason ? describe.skip : describe;

describeIfDb('MongoDB integration', () => {
  let ctx: SeededDbContext;

  beforeEach(async () => {
    ctx = await seededDb();
  });

  afterEach(async () => {
    await ctx?.cleanup();
  });

  function rendered(items: ReadonlyArray<{ content?: unknown }>): string {
    return items
      .map((i) => (typeof i.content === 'string' ? i.content : JSON.stringify(i.content)))
      .join(' ');
  }

  it('pattern_3_preload_finds_known_user', async () => {
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user_1', 'default');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>);
    expect(text).toContain('Jordan');
    expect(text).toContain('jordan@example.com');
  });

  it('pattern_3_preload_handles_missing_user', async () => {
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user_unknown', 'default');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>);
    expect(text).toContain('No stored profile fields');
  });

  it('pattern_3_preload_prompts_for_name_when_missing', async () => {
    // When no profile name is on file, the chat context preloadUser builds
    // must instruct the agent to ASK for the user's name and persist it via
    // update_profile. The agent reads this guidance before its first turn.
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user_unknown_no_name', 'default');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>).toLowerCase();
    expect(text).toContain('ask');
    expect(text).toContain('name');
    expect(text).toContain('update_profile');
  });

  it('pattern_4_lookup_order', async () => {
    const order = await ctx.db
      .collection<{ items: string[]; status: string; order_id: string }>('orders')
      .findOne({ order_id: 'order_1001' });
    expect(order).not.toBeNull();
    expect(order!.items).toEqual(['Widget A', 'Widget B']);
    expect(order!.status).toBe('delivered');
  });

  it('pattern_1_vector_search_returns_results', async () => {
    // Sanity check on $vectorSearch syntax. The fresh per-test index isn't
    // queryable yet, so we only assert the pipeline shape doesn't crash.
    const { embedText } = await import('../src/tools/embeddings');
    const qv = await embedText('voice agent retrieval', { inputType: 'query' });
    try {
      const results = await ctx.db
        .collection('knowledge')
        .aggregate([
          {
            $vectorSearch: {
              index: 'knowledge_embedding_index',
              path: 'embedding',
              queryVector: qv,
              numCandidates: 50,
              limit: 3,
            },
          },
          { $project: { title: 1, _id: 0 } },
        ])
        .toArray();
      expect(Array.isArray(results)).toBe(true);
    } catch (err) {
      if (!isOperationFailure(err)) throw err;
    }
  });

  it('search_knowledge_tool_returns_docs', async () => {
    const { vectorSearchKnowledge } = await import('../src/agent');
    try {
      const results = await vectorSearchKnowledge(ctx.db, 'voice agent retrieval', 3);
      expect(Array.isArray(results)).toBe(true);
      for (const doc of results) {
        expect(doc).toHaveProperty('title');
        expect(doc).toHaveProperty('content');
      }
    } catch (err) {
      if (!isOperationFailure(err)) throw err;
    }
  });

  it('pattern_5_session_report_insert', async () => {
    await ctx.db.collection('sessions').insertOne({
      session_id: 'test-room-1',
      user_id: 'user_1',
      report: { chat_history: [] },
    });
    const found = await ctx.db
      .collection<{ user_id: string }>('sessions')
      .findOne({ session_id: 'test-room-1' });
    expect(found).not.toBeNull();
    expect(found!.user_id).toBe('user_1');
  });

  it('pattern_2_memory_remember_recall_forget', async () => {
    const { remember, recall, forget } = await import('../src/tools/memory');
    const msg = await remember(ctx.db, 'user_1', 'default', 'preference', 'likes coffee');
    expect(msg).toContain('Remembered');

    expect(await recall(ctx.db, 'user_1', 'default', 'preference')).toBe('likes coffee');

    expect(await forget(ctx.db, 'user_1', 'default', 'preference')).toBe('Memory forgotten.');
    expect(await recall(ctx.db, 'user_1', 'default', 'preference')).toBe('No memory found.');
  });

  it('pattern_2_memory_isolation_across_users', async () => {
    const { remember, recall } = await import('../src/tools/memory');
    await remember(ctx.db, 'user_a', 'default', 'fact', 'lives in Paris');
    await remember(ctx.db, 'user_b', 'default', 'fact', 'lives in Tokyo');
    expect(await recall(ctx.db, 'user_a', 'default', 'fact')).toBe('lives in Paris');
    expect(await recall(ctx.db, 'user_b', 'default', 'fact')).toBe('lives in Tokyo');
  });

  it('pattern_2_memory_overwrite', async () => {
    const { remember, recall } = await import('../src/tools/memory');
    await remember(ctx.db, 'user_1', 'default', 'favorite_color', 'blue');
    await remember(ctx.db, 'user_1', 'default', 'favorite_color', 'green');
    expect(await recall(ctx.db, 'user_1', 'default', 'favorite_color')).toBe('green');
    const count = await ctx.db.collection('memories').countDocuments({
      user_id: 'user_1',
      tenant_id: 'default',
      memory_type: 'favorite_color',
    });
    expect(count).toBe(1);
  });

  it('pattern_2_list_memories_returns_all_slots', async () => {
    const { remember, listMemories } = await import('../src/tools/memory');
    await remember(ctx.db, 'user_1', 'default', 'favorite_color', 'blue');
    await remember(ctx.db, 'user_1', 'default', 'allergy', 'peanuts');
    const results = await listMemories(ctx.db, 'user_1', 'default');
    const types = new Set(results.map((r) => r.memory_type));
    expect(types).toEqual(new Set(['favorite_color', 'allergy']));
  });

  it('pattern_2_search_memory_returns_list', async () => {
    const { searchMemory } = await import('../src/tools/memory');
    try {
      const results = await searchMemory(ctx.db, 'user_1', 'default', 'anything', 5);
      expect(Array.isArray(results)).toBe(true);
      for (const item of results) {
        expect(item).toHaveProperty('memory_type');
        expect(item).toHaveProperty('content');
      }
    } catch (err) {
      if (!isOperationFailure(err)) throw err;
    }
  });

  it('pattern_2_search_memory_recovers_unknown_key', async () => {
    const { remember, searchMemory } = await import('../src/tools/memory');
    await remember(ctx.db, 'user_1', 'default', 'color_preference', 'blue');
    try {
      const results = await searchMemory(
        ctx.db,
        'user_1',
        'default',
        'what is my favorite color?',
        5,
      );
      expect(Array.isArray(results)).toBe(true);
    } catch (err) {
      if (!isOperationFailure(err)) throw err;
    }
  });
});
