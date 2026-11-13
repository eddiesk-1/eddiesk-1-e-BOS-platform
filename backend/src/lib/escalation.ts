/**
 * When should the AI receptionist hand a conversation to a person?
 *
 * Two independent signals, both ending in the same database call
 * (chat_request_handoff):
 *   1. DETERMINISTIC — the visitor's own words match a pattern for asking
 *      for a human, complaining, or negotiating price/quotes.
 *   2. MODEL-REPORTED — the system prompt tells the model to end its reply
 *      with [[HANDOFF:reason]] when it cannot answer from the business
 *      context. The server strips the marker, validates the reason against
 *      a fixed list, and never shows it to the visitor. A visitor typing
 *      the marker themselves does nothing: only the model's reply is parsed.
 *
 * Asking for a human is always honoured. Pricing/complaint/low-confidence
 * escalation can be switched off per business (business_ai_settings
 * .auto_escalation).
 */
export type HandoffReason =
  | 'visitor_requested'
  | 'complaint'
  | 'pricing'
  | 'low_confidence';

const REQUEST_RE =
  /\b(?:speak|talk|chat|connect|transfer)\b[^.?!]{0,20}\b(?:to|with|me)\b[^.?!]{0,20}\b(?:human|person|someone|agent|representative|rep|staff|manager|owner|somebody)\b|\b(?:real|actual|live)\s+(?:person|human|agent)\b|\bhuman\s+(?:agent|being|please)\b|\bcall\s+me\b/i;

const COMPLAINT_RE =
  /\b(?:complain(?:t|ing|ed)?|refund|scam|fraud(?:ulent)?|terrible|awful|unacceptable|furious|disgusted|never\s+(?:received|arrived|came)|did\s*n'?t\s+(?:receive|arrive)|wrong\s+(?:item|order|product)|damaged|faulty|rip[\s-]?off|cheated|lawyer|sue)\b/i;

const PRICING_RE =
  /\b(?:discount|negotiat\w*|bulk\s+(?:price|pricing|order|buy)|wholesale|custom\s+(?:quote|order|price)|quotation|quote\s+for|cheaper|best\s+price|haggle|price\s+match|special\s+price)\b/i;

export function detectEscalation(visitorText: string): HandoffReason | null {
  if (!visitorText) return null;
  if (REQUEST_RE.test(visitorText)) return 'visitor_requested';
  if (COMPLAINT_RE.test(visitorText)) return 'complaint';
  if (PRICING_RE.test(visitorText)) return 'pricing';
  return null;
}

const MARKER_RE = /\[\[\s*HANDOFF\s*:\s*(pricing|complaint|low_confidence|visitor_requested)\s*\]\]/gi;

export function extractHandoffMarker(modelText: string): { text: string; reason: HandoffReason | null } {
  let reason: HandoffReason | null = null;
  const text = modelText
    .replace(MARKER_RE, (_m, r: string) => {
      reason ??= r.toLowerCase() as HandoffReason;
      return '';
    })
    .replace(/\[\[\s*HANDOFF[^\]]*\]\]/gi, '') // any malformed variant is dropped, never shown
    .trim();
  return { text, reason };
}

export function handoffNotice(reason: HandoffReason): string {
  switch (reason) {
    case 'pricing':
      return "I've asked a team member to follow up with you about pricing — they'll join this chat shortly.";
    case 'complaint':
      return "I'm sorry about that. I've asked a team member to look into this and join this chat shortly.";
    case 'visitor_requested':
      return "Of course — I've asked a team member to join this chat. They'll reply here shortly.";
    default:
      return "I'm not certain about that, so I've asked a team member to join this chat and help.";
  }
}

/** Reasons the visitor explicitly asked for are never gated by settings. */
export function shouldEscalate(reason: HandoffReason, autoEscalationEnabled: boolean): boolean {
  return reason === 'visitor_requested' || autoEscalationEnabled;
}
