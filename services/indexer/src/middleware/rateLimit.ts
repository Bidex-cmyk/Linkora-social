import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

// ── Configuration ─────────────────────────────────────────────────────────────

const RATE_LIMIT_ANON_RPM = parseInt(process.env.RATE_LIMIT_ANON_RPM || "100", 10);
const RATE_LIMIT_AUTH_RPM = parseInt(process.env.RATE_LIMIT_AUTH_RPM || "300", 10);
const RATE_LIMIT_WRITE_RPM = parseInt(process.env.RATE_LIMIT_WRITE_RPM || "50", 10);
const WINDOW_MS = 60_000; // 1 minute

// ── In-memory sliding window implementation ────────────────────────────────────

interface RateWindow {
  requests: number[];
}

class RateLimiter {
  private windows = new Map<string, RateWindow>();

  isAllowed(key: string, limit: number): boolean {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window) {
      this.windows.set(key, { requests: [now] });
      return true;
    }

    window.requests = window.requests.filter((time) => now - time < WINDOW_MS);

    if (window.requests.length < limit) {
      window.requests.push(now);
      return true;
    }

    return false;
  }

  getRemainingTime(key: string): number {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || window.requests.length === 0) {
      return WINDOW_MS;
    }

    const oldestRequest = Math.min(...window.requests);
    return Math.max(0, WINDOW_MS - (now - oldestRequest));
  }

  getRequestCount(key: string): number {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window) {
      return 0;
    }

    window.requests = window.requests.filter((time) => now - time < WINDOW_MS);
    return window.requests.length;
  }
}

const limiter = new RateLimiter();

// ── Helper: extract IP address with trusted proxy validation ─────────────────

export const DEFAULT_TRUSTED_PROXIES = [
  "127.0.0.1/32",
  "127.0.0.1",
  "::1/128",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

export function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  let cleaned = ip.trim();
  if (cleaned.startsWith("::ffff:")) {
    cleaned = cleaned.substring(7);
  }
  return cleaned;
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const normalizedCidr = normalizeIp(cidr);

  if (!normalizedCidr.includes("/")) {
    return normalizedIp === normalizedCidr;
  }

  const [range, bitsStr] = normalizedCidr.split("/");
  const bits = parseInt(bitsStr, 10);

  const ipLong = ipv4ToLong(normalizedIp);
  const rangeLong = ipv4ToLong(range);
  if (ipLong !== null && rangeLong !== null && !isNaN(bits) && bits >= 0 && bits <= 32) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipLong & mask) === (rangeLong & mask);
  }

  if (normalizedIp === range) {
    return true;
  }

  return false;
}

export function getClientIP(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string }; ip?: string },
  customTrustedProxies?: string[]
): string {
  const trustedList =
    customTrustedProxies ??
    (process.env.TRUSTED_PROXIES
      ? process.env.TRUSTED_PROXIES.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_TRUSTED_PROXIES);

  const socketIp = normalizeIp(req.socket?.remoteAddress || req.ip || "unknown");

  const isDirectConnectionTrusted = trustedList.some((cidr) => isIpInCidr(socketIp, cidr));

  if (!isDirectConnectionTrusted) {
    return socketIp;
  }

  const rawXff = req.headers["x-forwarded-for"];
  if (!rawXff) {
    return socketIp;
  }

  const xffHeader = Array.isArray(rawXff) ? rawXff.join(",") : String(rawXff);
  const ips = xffHeader
    .split(",")
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);

  if (ips.length === 0) {
    return socketIp;
  }

  for (let i = ips.length - 1; i >= 0; i--) {
    const candidateIp = ips[i];
    const isTrusted = trustedList.some((cidr) => isIpInCidr(candidateIp, cidr));
    if (!isTrusted) {
      return candidateIp;
    }
  }

  return ips[0];
}

// ── Helper: determine if endpoint is write ────────────────────────────────────

function isWriteEndpoint(path: string, method: string): boolean {
  return ["POST", "PUT", "DELETE", "PATCH"].includes(method);
}

// ── Rate limit middleware for read endpoints ──────────────────────────────────

export function rateLimitRead(req: Request, res: Response, next: NextFunction): void {
  const key = req.context?.stellarAddress || getClientIP(req);
  const limit = req.context?.stellarAddress ? RATE_LIMIT_AUTH_RPM : RATE_LIMIT_ANON_RPM;

  if (limiter.isAllowed(key, limit)) {
    next();
    return;
  }

  const retryAfterMs = limiter.getRemainingTime(key);
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

  logger.warn(
    {
      requestId: req.context?.requestId,
      identifier: key,
      endpoint: req.path,
      limit,
    },
    "Rate limit exceeded for read endpoint"
  );

  res.status(429).set("Retry-After", String(retryAfterSeconds)).json({
    error: "Too many requests. Please retry after the indicated delay.",
    code: "RATE_LIMIT_EXCEEDED",
    retryAfterSeconds,
  });
}

// ── Rate limit middleware for write endpoints ──────────────────────────────────

export function rateLimitWrite(req: Request, res: Response, next: NextFunction): void {
  const key = req.context?.stellarAddress || getClientIP(req);
  const limit = req.context?.stellarAddress ? RATE_LIMIT_AUTH_RPM : RATE_LIMIT_WRITE_RPM;

  if (limiter.isAllowed(key, limit)) {
    next();
    return;
  }

  const retryAfterMs = limiter.getRemainingTime(key);
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

  logger.warn(
    {
      requestId: req.context?.requestId,
      identifier: key,
      endpoint: req.path,
      limit,
    },
    "Rate limit exceeded for write endpoint"
  );

  res.status(429).set("Retry-After", String(retryAfterSeconds)).json({
    error: "Too many requests. Please retry after the indicated delay.",
    code: "RATE_LIMIT_EXCEEDED",
    retryAfterSeconds,
  });
}

// ── Unified rate limit middleware (auto-detects read vs write) ────────────────

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (isWriteEndpoint(req.path, req.method)) {
    rateLimitWrite(req, res, next);
  } else {
    rateLimitRead(req, res, next);
  }
}

// ── Reset limiter state (for tests) ──────────────────────────────────────────

export function resetRateLimiter(): void {
  const l = limiter as unknown as { windows: Map<string, RateWindow> };
  l.windows.clear();
}

// ── Export the limiter for testing ─────────────────────────────────────────────

export { RateLimiter };
export const getRateLimiterInstance = () => limiter;
