// Live Voyage AI smoke test, ported from the corresponding Python case.
// All other tests stub embeddings to stay inside the free-tier rate limit;
// this is the one place we hit the real API to verify model/dimensions.
//
// Voyage returns 401 for invalid keys and 403 when a valid key is over its
// free-tier RPM cap (3 RPM without a payment method). We treat 403/429 as
// "skip with a log line" so contributors on free tier still see a green
// suite, while a genuine auth failure (401) still fails the test.
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, embedText } from '../src/tools/embeddings.ts';

describe('Voyage live API', () => {
  it.skipIf(!process.env.VOYAGE_API_KEY)('voyage_returns_correct_dimensions', async (ctx) => {
    let vector: number[];
    try {
      vector = await embedText('livekit mongodb starter dimension check', {
        inputType: 'query',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('(403 ') || msg.includes('(429 ')) {
        console.warn(`Skipping Voyage smoke test (free-tier rate limit): ${msg}`);
        ctx.skip();
        return;
      }
      throw err;
    }
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const v of vector) {
      expect(typeof v).toBe('number');
    }
  });
});
