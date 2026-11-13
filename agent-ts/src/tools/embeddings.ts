// Voyage AI text-embedding helper for MongoDB vector search.
//
// Uses voyage-3.5-lite (1024 dimensions). The vector index in db/indexes.ts
// must use the same numDimensions value.
//
// Voyage has no first-class Node SDK that handles MongoDB-Atlas-issued keys
// correctly, so we hit the HTTP API directly. Atlas-issued keys (prefix
// `al-`) are gated to `ai.mongodb.com`; direct Voyage keys (everything else)
// hit `api.voyageai.com`. The Python SDK does the same prefix routing in
// `voyageai/util.py:get_default_base_url`.

export const EMBEDDING_MODEL = 'voyage-3.5-lite';
export const EMBEDDING_DIMENSIONS = 1024;

export type VoyageInputType = 'query' | 'document';

interface VoyageEmbedOptions {
  inputType?: VoyageInputType;
}

interface VoyageEmbeddingItem {
  embedding: number[];
  index: number;
  object: string;
}

interface VoyageEmbeddingResponse {
  data: VoyageEmbeddingItem[];
  model: string;
  object: string;
  usage: { total_tokens: number };
}

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error('VOYAGE_API_KEY environment variable is not set.');
  }
  return key;
}

function endpointFor(apiKey: string): string {
  return apiKey.startsWith('al-')
    ? 'https://ai.mongodb.com/v1/embeddings'
    : 'https://api.voyageai.com/v1/embeddings';
}

async function callVoyage(
  input: string[],
  inputType: VoyageInputType | undefined,
): Promise<number[][]> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    input,
    model: EMBEDDING_MODEL,
    output_dimension: EMBEDDING_DIMENSIONS,
  };
  if (inputType) {
    body.input_type = inputType;
  }

  const response = await fetch(endpointFor(apiKey), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `Voyage embeddings request failed (${response.status} ${response.statusText}): ${errBody}`,
    );
  }

  const json = (await response.json()) as VoyageEmbeddingResponse;
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/** Return a 1024-dimensional embedding for a single text. */
export async function embedText(text: string, opts: VoyageEmbedOptions = {}): Promise<number[]> {
  const embeddings = await callVoyage([text], opts.inputType);
  if (embeddings.length === 0) {
    throw new Error('Voyage embeddings response did not contain any embeddings.');
  }
  return embeddings[0]!;
}

/** Batch-embed a list of texts (one HTTP round-trip). */
export async function embedTexts(
  texts: string[],
  opts: VoyageEmbedOptions = {},
): Promise<number[][]> {
  return callVoyage(texts, opts.inputType);
}
