/**
 * Rule-based region inference for chat routing.
 *
 * Routing (conversations.consumer_region_label -> transaction_paths) only
 * works when the conversation's label EXACTLY matches (case-insensitive) a
 * region label some staff member has registered. So this never invents a
 * label: it can only return one of the labels the business already uses.
 *
 * Two ways to match, in order:
 *   1. a registered label itself appears in the visitor's words
 *      ("I'm in Greater Accra" with a "Greater Accra" label);
 *   2. a well-known Ghanaian town/city implies a region, and a registered
 *      label contains that region's name or the town ("Kumasi" -> Ashanti).
 *
 * It is a plain text matcher, not machine learning: it will miss
 * misspellings and places not listed here. When it cannot decide it
 * returns null and routing falls back to owners/"handles anywhere" staff.
 */

// town -> region (lowercase). Not exhaustive; extend as needed.
export const GHANA_TOWN_TO_REGION: Record<string, string> = {
  accra: 'greater accra', tema: 'greater accra', madina: 'greater accra', kasoa: 'central', spintex: 'greater accra',
  osu: 'greater accra', labadi: 'greater accra', teshie: 'greater accra', nungua: 'greater accra', adenta: 'greater accra',
  kumasi: 'ashanti', obuasi: 'ashanti', konongo: 'ashanti', ejisu: 'ashanti',
  takoradi: 'western', sekondi: 'western', tarkwa: 'western',
  'cape coast': 'central', winneba: 'central', elmina: 'central', mankessim: 'central',
  koforidua: 'eastern', nkawkaw: 'eastern', akim: 'eastern', suhum: 'eastern',
  tamale: 'northern', yendi: 'northern', savelugu: 'northern',
  bolgatanga: 'upper east', navrongo: 'upper east', bawku: 'upper east',
  wa: 'upper west', tumu: 'upper west', lawra: 'upper west',
  sunyani: 'bono', berekum: 'bono', techiman: 'bono east', kintampo: 'bono east',
  ho: 'volta', keta: 'volta', hohoe: 'volta', aflao: 'volta',
  damongo: 'savannah', bole: 'savannah', goaso: 'ahafo', nalerigu: 'north east',
  dambai: 'oti', sefwi: 'western north', wiawso: 'western north',
};

// Short words that are also ordinary English: only count after a place word.
const AMBIGUOUS = new Set(['wa', 'ho']);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`(^| )${escapeRe(phrase)}( |$)`).test(haystack);
}

function hasAmbiguousPlace(haystack: string, place: string): boolean {
  return new RegExp(`(^| )(in|from|at|near|to|around) ${escapeRe(place)}( |$)`).test(haystack);
}

export function inferRegion(visitorText: string, registeredLabels: string[]): string | null {
  const text = norm(visitorText);
  if (!text) return null;
  const labels = registeredLabels
    .map((label) => ({ label, n: norm(label) }))
    .filter((l) => l.n.length >= 2);
  if (labels.length === 0) return null;

  // 1. A registered label appears directly. Prefer the longest match.
  const direct = labels
    .filter((l) => (AMBIGUOUS.has(l.n) ? hasAmbiguousPlace(text, l.n) : hasPhrase(text, l.n)))
    .sort((a, b) => b.n.length - a.n.length);
  if (direct.length > 0) return direct[0].label;

  // 2. A known town implies a region that some registered label covers.
  for (const [town, region] of Object.entries(GHANA_TOWN_TO_REGION)) {
    const present = AMBIGUOUS.has(town) ? hasAmbiguousPlace(text, town) : hasPhrase(text, town);
    if (!present) continue;
    const match = labels.find((l) => l.n.includes(region) || l.n === town);
    if (match) return match.label;
  }
  return null;
}
