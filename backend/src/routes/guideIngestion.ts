import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { encryptSecret, decryptSecret } from '../lib/encryption.js';
import { randomUUID } from 'node:crypto';

/**
 * The pipeline knowledge_chunks (migrations/003_ledger_and_knowledge.js)
 * was built for but never had: taking a real operating guide's text,
 * splitting it into chunks, embedding each chunk, and writing real rows
 * — closing the gap routes/ai.ts's reception-salesperson endpoint
 * explicitly flagged ("no guide-ingestion pipeline exists yet ... the
 * retrieval query is real, working code ... but returns nothing for
 * every business, because nothing has ever written a row to that
 * table").
 *
 * EMBEDDINGS PROVIDER, BY DESIGN: Anthropic has no embeddings API — this
 * is a hard, unavoidable fact, not a choice this backend is making.
 * Per the brief this was built against: "it could be any AI, which the
 * person using it has to paste an API key for (could accept any), and
 * they follow platform playbooks." That means embeddings-provider
 * credentials are BUSINESS-scoped configuration an owner supplies (see
 * migrations/018_business_integrations.js), not a single global
 * .env-level key the way ANTHROPIC_API_KEY is for the rest of this
 * service. callEmbeddingsProvider() below is the one function that
 * knows how to actually talk to a given provider's API shape — adding a
 * new provider is a change there, not a schema change.
 *
 * WHO PAYS: "only visitors spend the owners' tokens" — a visitor's
 * conversation with the AI receptionist draws on retrieval against
 * THIS business's own configured embeddings key, at query time (see
 * routes/ai.ts's gatherBusinessContext, which this pipeline is meant to
 * eventually feed real rows into — that wiring is a followup, not done
 * in this file). What THIS file does is the ingestion half: an owner
 * uploading their guide, authenticated, spending their OWN key to
 * populate their OWN business's knowledge_chunks. No visitor-facing
 * route in this file at all.
 */

interface StoreIntegrationBody {
  businessId?: string;
  provider?: string;
  apiKey?: string;
}

interface IngestGuideBody {
  businessId?: string;
  guideText?: string;
}

const CHUNK_SIZE_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;

/**
 * Splits guide text into overlapping chunks by character count, breaking
 * on paragraph boundaries where possible rather than mid-sentence.
 * Character-based, not token-based — this project has no tokenizer
 * dependency already in place, and a real tokenizer would be a new
 * dependency this backend doesn't otherwise need; character count is a
 * reasonable, honest approximation, not a precise token budget.
 * CHUNK_OVERLAP_CHARS exists so a fact split across a chunk boundary in
 * the original text still appears whole in at least one chunk.
 */
export function chunkGuideText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= CHUNK_SIZE_CHARS) return [trimmed];

  const paragraphs = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > CHUNK_SIZE_CHARS && current.length > 0) {
      chunks.push(current.trim());
      // Overlap: carry the tail of the previous chunk forward, rather
      // than starting the next chunk from a hard zero — a sentence that
      // straddled the cut point is still readable in context in the
      // NEXT chunk too, not just orphaned in the one that ends mid-idea.
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP_CHARS);
      current = current.slice(overlapStart);
    }
    current = current.length > 0 ? current + '\n\n' + para : para;

    // A single paragraph longer than CHUNK_SIZE_CHARS on its own still
    // needs to be split — hard-cut it rather than emit one giant chunk
    // that blows the embeddings provider's own input-size limit.
    while (current.length > CHUNK_SIZE_CHARS) {
      chunks.push(current.slice(0, CHUNK_SIZE_CHARS).trim());
      current = current.slice(CHUNK_SIZE_CHARS - CHUNK_OVERLAP_CHARS);
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/**
 * Dispatches to whichever provider a business has configured. Each
 * branch here is a real, distinct API shape — these are NOT
 * interchangeable, which is exactly why this needs to be a real
 * function with real per-provider logic, not a single generic template
 * that happens to work for one provider and silently breaks for
 * another.
 *
 * Two providers implemented: OpenAI (the most common embeddings API
 * shape, and what knowledge_chunks.embedding's vector(1536) dimension
 * already assumes — see that migration's own column definition) and
 * Voyage AI (Anthropic's own recommended embeddings partner, since
 * Anthropic itself has none). Both return 1536-dimension vectors for
 * the specific models used below — a provider/model combination that
 * returns a DIFFERENT dimension would fail at the database insert
 * (vector(1536) is a fixed-width column), which is a real constraint
 * worth knowing before adding a third provider casually.
 */
async function callEmbeddingsProvider(
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

export default async function guideIngestionRoutes(fastify: FastifyInstance) {
  /**
   * POST /businesses/:businessId/integrations — an owner/worker stores
   * (or replaces) their embeddings provider credentials for this
   * business. The API key is encrypted before it ever reaches the
   * database (lib/encryption.ts) — this route never logs, echoes, or
   * returns the plaintext key back in its response, only a confirmation
   * that it was stored.
   */
  fastify.post<{ Params: { businessId: string }; Body: StoreIntegrationBody }>(
    '/businesses/:businessId/integrations',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { provider, apiKey } = request.body ?? {};
      if (!provider || typeof provider !== 'string') {
        reply.code(400).send({ error: 'bad_request', message: 'provider is required' });
        return;
      }
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'apiKey is required' });
        return;
      }

      const encrypted = encryptSecret(apiKey);
      // ON CONFLICT on the (business_id, integration_type) unique
      // constraint from migration 018 — storing a new key for a
      // provider a business already configured REPLACES it outright,
      // rather than erroring or silently creating a second, ambiguous
      // row for the same integration_type.
      const result = await request.db.query(
        `INSERT INTO business_integrations (business_id, integration_type, provider, encrypted_api_key, encryption_iv, encryption_auth_tag, updated_at)
         VALUES ($1, 'embeddings', $2, $3, $4, $5, now())
         ON CONFLICT (business_id, integration_type)
         DO UPDATE SET provider = $2, encrypted_api_key = $3, encryption_iv = $4, encryption_auth_tag = $5, updated_at = now()
         RETURNING id, business_id, integration_type, provider, created_at, updated_at`,
        [request.params.businessId, provider, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business not found' });
        return;
      }
      const row = result.rows[0];
      reply.code(201).send({
        id: row.id,
        businessId: row.business_id,
        integrationType: row.integration_type,
        provider: row.provider,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Deliberately no apiKey field anywhere in this response — see
        // this route's own comment above.
      });
    }),
  );

  /**
   * POST /businesses/:businessId/guides/ingest — the actual pipeline.
   * Body: { guideText }. Requires the business to already have an
   * 'embeddings' integration configured (via the route above) — this
   * endpoint does NOT accept an inline apiKey itself, so a business's
   * key is stored once and reused across every future ingestion, rather
   * than re-supplied (and re-risked in a request log) on every guide
   * upload.
   *
   * Chunks the text, calls the configured provider ONCE with the whole
   * batch (both OpenAI's and Voyage's embeddings endpoints accept an
   * array of inputs in one request — batching this way is a real,
   * meaningful cost/latency improvement over one request per chunk, not
   * a premature optimization), and inserts one knowledge_chunks row per
   * resulting embedding, all sharing one fresh source_guide_id so a
   * later "delete this guide's chunks and re-ingest" operation has a
   * single, real id to delete by.
   */
  fastify.post<{ Params: { businessId: string }; Body: IngestGuideBody }>(
    '/businesses/:businessId/guides/ingest',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { guideText } = request.body ?? {};
      if (!guideText || typeof guideText !== 'string' || guideText.trim().length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'guideText is required' });
        return;
      }

      const integrationResult = await request.db.query(
        `SELECT provider, encrypted_api_key, encryption_iv, encryption_auth_tag
         FROM business_integrations
         WHERE business_id = $1 AND integration_type = 'embeddings'`,
        [request.params.businessId],
      );
      if (integrationResult.rows.length === 0) {
        reply.code(400).send({
          error: 'no_embeddings_provider',
          message:
            'This business has no embeddings provider configured yet. ' +
            'POST an apiKey to /businesses/:businessId/integrations first.',
        });
        return;
      }
      const integration = integrationResult.rows[0];

      const chunks = chunkGuideText(guideText);
      if (chunks.length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'guideText produced no chunks after trimming' });
        return;
      }

      let apiKey: string;
      let embeddings: number[][];
      try {
        apiKey = decryptSecret({
          ciphertext: integration.encrypted_api_key,
          iv: integration.encryption_iv,
          authTag: integration.encryption_auth_tag,
        });
        embeddings = await callEmbeddingsProvider(integration.provider, apiKey, chunks);
      } catch (err) {
        request.log.warn({ err }, 'Guide ingestion embeddings call failed');
        reply.code(502).send({
          error: 'embeddings_provider_error',
          message: 'The configured embeddings provider could not be reached or rejected the request.',
        });
        return;
      }

      if (embeddings.length !== chunks.length) {
        // A real, worth-catching invariant: if a provider ever returns
        // a different count than what was sent, inserting embeddings[i]
        // against chunks[i] would silently pair the WRONG text with the
        // wrong vector for every row from that point on. Fail the whole
        // ingestion rather than write data that LOOKS complete but is
        // quietly misaligned.
        request.log.error(
          { sentCount: chunks.length, receivedCount: embeddings.length },
          'Embeddings provider returned a mismatched result count',
        );
        reply.code(502).send({
          error: 'embeddings_provider_error',
          message: 'The embeddings provider returned an unexpected number of results.',
        });
        return;
      }

      const sourceGuideId = randomUUID();
      const insertedIds: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const vectorLiteral = `[${embeddings[i].join(',')}]`;
        const insertResult = await request.db.query(
          `INSERT INTO knowledge_chunks (business_id, source_guide_id, content, embedding)
           VALUES ($1, $2, $3, $4::vector)
           RETURNING id`,
          [request.params.businessId, sourceGuideId, chunks[i], vectorLiteral],
        );
        insertedIds.push(insertResult.rows[0].id);
      }

      reply.code(201).send({
        sourceGuideId,
        chunksCreated: insertedIds.length,
        chunkIds: insertedIds,
      });
    }),
  );

  /**
   * DELETE /businesses/:businessId/guides/:sourceGuideId — removes every
   * chunk from one ingestion run. Exists because re-ingesting an updated
   * guide without this would leave the OLD guide's chunks sitting
   * alongside the new ones forever, silently growing stale context the
   * AI receptionist could still retrieve from.
   */
  fastify.delete<{ Params: { businessId: string; sourceGuideId: string } }>(
    '/businesses/:businessId/guides/:sourceGuideId',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM knowledge_chunks WHERE business_id = $1 AND source_guide_id = $2 RETURNING id`,
        [request.params.businessId, request.params.sourceGuideId],
      );
      reply.send({ chunksDeleted: result.rows.length });
    }),
  );
}
