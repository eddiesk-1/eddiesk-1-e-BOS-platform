import 'dotenv/config';
import { EMBEDDING_DIMENSIONS, EmbeddingDimensionError, callEmbeddingsProvider, normalizeEmbeddingDimension } from '../lib/embeddings.js';

/**
 * Confirms, with YOUR real key, that guide ingestion's embeddings call
 * works and that the vectors fit the database column (vector(1536)).
 *
 *   VERIFY_PROVIDER=openai VERIFY_API_KEY=sk-... npm run verify:embeddings
 *   VERIFY_PROVIDER=voyage VERIFY_API_KEY=pa-... npm run verify:embeddings
 *
 * It sends two short test sentences (cost: a fraction of a cent), prints
 * the vector size it got back and whether ingestion would accept it
 * as-is, zero-pad it, or refuse it. The key is read from the environment
 * so it never lands in shell history as an argument, and is never printed.
 * It does not touch your database.
 */
const provider = (process.env.VERIFY_PROVIDER ?? '').trim().toLowerCase();
const apiKey = (process.env.VERIFY_API_KEY ?? '').trim();

if (!provider || !apiKey) {
  console.error('Set VERIFY_PROVIDER (openai | voyage) and VERIFY_API_KEY. Example:\n  VERIFY_PROVIDER=openai VERIFY_API_KEY=sk-... npm run verify:embeddings');
  process.exit(2);
}

try {
  const vectors = await callEmbeddingsProvider(provider, apiKey, [
    'We deliver bread across Kumasi and Accra every morning.',
    'The shop is closed on Sundays.',
  ]);
  const dim = vectors[0]?.length ?? 0;
  console.log(`provider:        ${provider}`);
  console.log(`vectors:         ${vectors.length}`);
  console.log(`dimensions:      ${dim}   (database column: ${EMBEDDING_DIMENSIONS})`);
  try {
    const normalised = vectors.map((v) => normalizeEmbeddingDimension(v));
    console.log(
      dim === EMBEDDING_DIMENSIONS
        ? 'result:          OK — stored as returned.'
        : `result:          OK — ${dim} dimensions will be zero-padded to ${EMBEDDING_DIMENSIONS} (similarity is unchanged).`,
    );
    console.log(`stored length:   ${normalised[0].length}`);
  } catch (err) {
    if (err instanceof EmbeddingDimensionError) {
      console.log(`result:          REFUSED — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
} catch (err) {
  // Provider error bodies are truncated by callEmbeddingsProvider and never contain the key.
  console.error('FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
