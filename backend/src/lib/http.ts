/**
 * HTTP-level security helpers: response headers (including the Content
 * Security Policy) and the session cookie. Pure functions, no Fastify.
 *
 * CSP NOTES. The two frontends are single HTML files with inline <script>
 * and <style>, so script-src and style-src must allow 'unsafe-inline'.
 * That weakens XSS protection compared with a nonce-based policy, and it
 * is the honest cost of the single-file frontend architecture. What the
 * policy DOES still give: no third-party scripts at all, no framing
 * (clickjacking), no form posts or XHR to other origins, no plugin
 * content, and a pinned <base>. Moving to external script files + nonces
 * would let 'unsafe-inline' be dropped; that is a frontend refactor, not
 * a header change.
 */

export const SESSION_COOKIE = 'ebos_session';
export const CSRF_HEADER = 'x-ebos-client';

export function buildCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // Product media is owner-supplied https URLs.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(isProduction: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildCsp(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (isProduction) {
    headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  }
  return headers;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * HttpOnly (JavaScript cannot read it, so an XSS bug cannot steal it),
 * SameSite=Strict (never sent on cross-site requests) and Secure in
 * production. Cookie-authenticated writes additionally need the
 * X-Ebos-Client header (see plugins/auth.ts), which a cross-site page
 * cannot send without a CORS preflight this server refuses.
 */
export function serializeSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
