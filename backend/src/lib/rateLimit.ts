import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-memory sliding-window rate limiter. No dependency, no Redis.
 *
 * LIMITS OF THIS DESIGN (read before relying on it):
 *   - State lives in this process. With N server instances the effective
 *     limit is N x max, and a restart resets all counters. e-BOS runs as a
 *     single Render instance today, which is the case this is built for.
 *     If you scale out, move the counters to Postgres or Redis behind the
 *     same check() interface.
 *   - Keys are capped (maxKeys) so a flood of unique addresses cannot grow
 *     memory without bound; when full, expired entries are dropped first,
 *     then the oldest.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly opts: { windowMs: number; max: number; maxKeys?: number },
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    const { windowMs, max } = this.opts;
    const cutoff = now - windowMs;
    const existing = this.hits.get(key);
    const recent = existing ? existing.filter((t) => t > cutoff) : [];

    if (recent.length >= max) {
      this.hits.set(key, recent);
      const retryAfterMs = recent[0] + windowMs - now;
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    recent.push(now);
    this.hits.delete(key); // re-insert so Map order approximates recency
    this.hits.set(key, recent);
    this.evictIfNeeded(cutoff);
    return { allowed: true, remaining: max - recent.length, retryAfterSec: 0 };
  }

  /** Test/ops helper. */
  size(): number {
    return this.hits.size;
  }

  private evictIfNeeded(cutoff: number): void {
    const maxKeys = this.opts.maxKeys ?? 20000;
    if (this.hits.size <= maxKeys) return;
    for (const [k, v] of this.hits) {
      if (v.length === 0 || v[v.length - 1] <= cutoff) this.hits.delete(k);
    }
    while (this.hits.size > maxKeys) {
      const oldest = this.hits.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/** Fastify preHandler factory. Sends 429 with Retry-After when exceeded. */
export function rateLimitHook(
  limiter: RateLimiter,
  keyOf: (request: FastifyRequest) => string,
) {
  return async function rateLimited(request: FastifyRequest, reply: FastifyReply) {
    const result = limiter.check(keyOf(request));
    if (!result.allowed) {
      reply.header('Retry-After', String(result.retryAfterSec));
      return reply.code(429).send({
        error: 'rate_limited',
        message: `Too many requests. Try again in ${result.retryAfterSec} seconds.`,
      });
    }
    return undefined;
  };
}

export const byIp = (request: FastifyRequest): string => request.ip;
