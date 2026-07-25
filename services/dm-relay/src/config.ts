export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function optionalInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return parsed;
}

export function loadConfig() {
  return {
    port: optionalInt("PORT", 3001),
    nodeEnv: process.env.NODE_ENV || "development",
    databaseUrl: requireEnv("DATABASE_URL"),
    corsOrigin: process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"],
    messageTtlDays: optionalInt("MESSAGE_TTL_DAYS", 7),
    maxTimestampSkew: optionalInt("MAX_TIMESTAMP_SKEW", 30),
    stellarNetwork: process.env.STELLAR_NETWORK || "Testnet",
    idempotencyTtlHours: optionalInt("IDEMPOTENCY_TTL_HOURS", 24),
  };
}
