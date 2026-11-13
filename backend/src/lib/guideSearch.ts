/**
 * Turns what a visitor typed into a Postgres tsquery string, safely.
 *
 * Only [a-z0-9] terms survive, so nothing the visitor types can inject
 * tsquery operators or syntax. Terms are OR-ed (' | ') and ranked by
 * ts_rank in chat_ai_context (migration 020): a guide chunk that matches
 * more of the visitor's words ranks higher, but one matching word is
 * enough to be a candidate. (plainto_tsquery would AND the words, which
 * returns nothing for natural questions like "do you deliver to Kumasi?".)
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this',
  'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'yes', 'no', 'not', 'any', 'some', 'about', 'just', 'like',
  'want', 'need', 'looking', 'know', 'tell', 'get', 'got', 'also', 'so', 'than', 'then', 'them', 'they', 'us',
]);

export function buildTsQuery(texts: string | string[], maxTerms = 12): string {
  const input = Array.isArray(texts) ? texts.join(' ') : texts;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of input.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || raw.length > 30) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (/^[0-9]+$/.test(raw) && raw.length < 4) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(' | ');
}
