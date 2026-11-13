/**
 * knowledge_chunks.embedding is vector(1536) (migration 003). Providers
 * return different sizes (OpenAI text-embedding-3-small: 1536; Voyage's
 * voyage-2: 1024 at the time of writing). A wrong-sized vector used to
 * fail the INSERT with an opaque database error.
 *
 * Shorter vectors are right-padded with zeros. That is lossless for the
 * similarity measures pgvector uses here: zeros add nothing to a dot
 * product or a norm, so cosine similarity between two padded vectors
 * equals the original. Longer vectors are refused (truncating would
 * change meaning). A business must keep ONE provider for all its chunks;
 * mixing providers in one business is meaningless regardless of padding.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export class EmbeddingDimensionError extends Error {}

export function normalizeEmbeddingDimension(vector: number[], target = EMBEDDING_DIMENSIONS): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingDimensionError('empty embedding returned by provider');
  }
  if (vector.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new EmbeddingDimensionError('embedding contained a non-numeric value');
  }
  if (vector.length === target) return vector;
  if (vector.length > target) {
    throw new EmbeddingDimensionError(
      `provider returned ${vector.length} dimensions; this database stores ${target}. Choose a provider/model that returns ${target} or fewer.`,
    );
  }
  return vector.concat(new Array<number>(target - vector.length).fill(0));
}

/**
 * One real HTTPS call per provider. Not yet exercised against a live key in
 * this project — run `npm run verify:embeddings` (src/scripts/verifyEmbeddings.ts)
 * with your own key to confirm the request shape and the vector size.
 */
export async function callEmbeddingsProvider(
  provider: string,
  apiKey: string,
  texts: string[],
): Promise<number[][]> {
  if (provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI embeddings API error ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }

  if (provider === 'voyage') {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'voyage-2', input: texts }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage AI embeddings API error ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }

  throw new Error(
    `Unknown embeddings provider "${provider}". Supported: "openai", "voyage". ` +
      'To add another, extend callEmbeddingsProvider() in this file with that provider\'s real API shape — ' +
      'this is a real per-provider integration, not a generic template.',
  );
}
