/**
 * Shared configuration for the analytics oracle service.
 */

export interface OracleRateLimitConfig {
  windowMs: number;
  maxRequests: number;
  bypassIps: string[];
}

export interface OracleCacheConfig {
  /** Maximum number of attestation entries before LRU eviction. */
  maxSize: number;
  /** Milliseconds before a cached attestation is considered stale (TTL). */
  ttlMs: number;
}

function parseBypassIps(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

export const oracleRateLimitConfig: OracleRateLimitConfig = {
  windowMs: parseInt(process.env["ORACLE_RATE_LIMIT_WINDOW_MS"] ?? "60000", 10),
  maxRequests: parseInt(process.env["ORACLE_RATE_LIMIT_MAX_REQUESTS"] ?? "10", 10),
  bypassIps: parseBypassIps(process.env["ORACLE_RATE_LIMIT_BYPASS_IPS"]),
};

export const oracleCacheConfig: OracleCacheConfig = {
  maxSize: parseInt(process.env["ATTESTATION_CACHE_MAX_SIZE"] ?? "10000", 10),
  ttlMs: parseInt(process.env["ATTESTATION_CACHE_TTL_MS"] ?? "3600000", 10),
};
