/**
 * Rate limiting middleware for the DM relay.
 *
 * Uses express-rate-limit with a Redis store when REDIS_URL is set so limits
 * are shared across replicas. Falls back to the default in-memory store with
 * a startup warning when Redis is not configured.
 *
 * Multi-instance behaviour
 * ─────────────────────────
 * Set REDIS_URL to enable cross-instance rate limiting. Without it each
 * replica enforces its own independent window — limits can be bypassed by
 * hitting different instances.
 */

import { rateLimit, Options as RateLimitOptions } from "express-rate-limit";
import { NextFunction, Request, Response } from "express";
import { rateLimitedError } from "@linkora/types/src/errors";

function getClientIP(req: Request): string {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    return xForwardedFor.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

const RATE_LIMIT_ANON_RPM = parseInt(process.env.RATE_LIMIT_ANON_RPM || "100", 10);
const RATE_LIMIT_AUTH_RPM = parseInt(process.env.RATE_LIMIT_AUTH_RPM || "300", 10);

/**
 * Build a shared Redis store for express-rate-limit, or return undefined to
 * use the default in-memory store.
 *
 * We import `rate-limit-redis` dynamically so the module loads successfully
 * even when ioredis / rate-limit-redis are absent (single-instance deployments
 * that choose not to install Redis deps).
 */
async function buildRedisStore(redisUrl: string): Promise<RateLimitOptions["store"] | undefined> {
  try {
    const [{ default: Redis }, { RedisStore }] = await Promise.all([
      import("ioredis"),
      import("rate-limit-redis"),
    ]);

    const client = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await client.connect();

    return new RedisStore({
      // @ts-expect-error — rate-limit-redis accepts an ioredis client but its
      // types expect the `sendCommand` shape; the runtime works correctly.
      sendCommand: (...args: string[]) => client.call(...args),
      prefix: "rl:dm-relay:",
    });
  } catch (err) {
    // Log and fall through to in-memory so a missing package doesn't crash the
    // service.
    console.error("[rate-limiter] Failed to connect Redis store, falling back to in-memory:", err);
    return undefined;
  }
}

// Module-level promise; resolved once during startup via initRateLimiters().
let anonLimiter: ReturnType<typeof rateLimit>;
let authLimiter: ReturnType<typeof rateLimit>;

function buildLimiters(store?: RateLimitOptions["store"]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shared: any = {
    windowMs: 60_000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(store ? { store } : {}),
  };

  anonLimiter = rateLimit({
    ...shared,
    limit: RATE_LIMIT_ANON_RPM,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keyGenerator: (req: any) => getClientIP(req),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (_req: any, res: any) => {
      const err = rateLimitedError(`Max ${RATE_LIMIT_ANON_RPM} requests per minute per IP`);
      res.status(err.statusCode).json(err.toJSON(_req.requestId));
    },
  });

  authLimiter = rateLimit({
    ...shared,
    limit: RATE_LIMIT_AUTH_RPM,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keyGenerator: (req: any) => req.stellarAddress || getClientIP(req),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (_req: any, res: any) => {
      const err = rateLimitedError(
        `Max ${RATE_LIMIT_AUTH_RPM} requests per minute per authenticated user`
      );
      res.status(err.statusCode).json(err.toJSON(_req.requestId));
    },
  });
}

/**
 * Call once during server startup (before any requests are handled).
 *
 * Connects to Redis if REDIS_URL is set; otherwise falls back to in-memory
 * and logs a warning.
 */
export async function initRateLimiters(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    const store = await buildRedisStore(redisUrl);
    if (store) {
      console.info("[rate-limiter] Using Redis store (shared across instances)");
      buildLimiters(store);
      return;
    }
    // buildRedisStore logged the error; fall through to in-memory.
  } else {
    console.warn(
      "[rate-limiter] REDIS_URL is not set — using in-memory store. " +
        "Rate limit state is NOT shared across instances and will reset on restart. " +
        "Set REDIS_URL to enable cross-instance rate limiting."
    );
  }

  buildLimiters();
}

// ── Synchronous fallback so the middleware can be used before initRateLimiters
// completes (e.g. in tests that don't call init). ─────────────────────────────
buildLimiters(); // initialises with in-memory store

// ── Exported middleware ───────────────────────────────────────────────────────

export { anonLimiter, authLimiter };

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).stellarAddress) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (authLimiter as any)(req, res, next);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (anonLimiter as any)(req, res, next);
}
