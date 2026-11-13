import { RateLimiter } from './rateLimit.js';

/**
 * Every rate limiter in one place so the numbers can be reviewed (and
 * changed) together. Keys are chosen per route: the client IP for public
 * endpoints, plus a second per-target limiter (email address, conversation
 * id) where one address cycling through targets is the real risk.
 * In-memory, per instance — see rateLimit.ts for what that does and does
 * not protect against.
 */
const minute = 60_000;
const hour = 60 * minute;

export const limits = {
  /** Everything except health checks and payment webhooks. */
  global: new RateLimiter({ windowMs: minute, max: 600 }),

  login: new RateLimiter({ windowMs: 10 * minute, max: 20 }),
  loginEmail: new RateLimiter({ windowMs: 15 * minute, max: 10 }),

  signup: new RateLimiter({ windowMs: hour, max: 5 }),
  signupEmail: new RateLimiter({ windowMs: 24 * hour, max: 3 }),

  /** forgot-password, resend-verification, invites */
  emailActions: new RateLimiter({ windowMs: hour, max: 8 }),
  emailActionsEmail: new RateLimiter({ windowMs: hour, max: 3 }),

  /** verify-email, reset-password: token guessing */
  tokenAttempts: new RateLimiter({ windowMs: 15 * minute, max: 30 }),

  conversationStart: new RateLimiter({ windowMs: hour, max: 20 }),
  chatMessage: new RateLimiter({ windowMs: 10 * minute, max: 120 }),
  identify: new RateLimiter({ windowMs: hour, max: 20 }),

  /** Every call costs money (Anthropic). */
  aiReplyIp: new RateLimiter({ windowMs: hour, max: 40 }),
  aiReplyConversation: new RateLimiter({ windowMs: 10 * minute, max: 20 }),
  aiPublic: new RateLimiter({ windowMs: minute, max: 20 }),

  checkout: new RateLimiter({ windowMs: hour, max: 10 }),
  checkoutVerify: new RateLimiter({ windowMs: 10 * minute, max: 60 }),
};
