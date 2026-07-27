import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { Pool } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { randomUUID } from "crypto";
import { encodeReport } from "./codec.js";
import { signReport } from "./signer.js";
import { fetchCreatorStats } from "./db.js";
import { submitAttestation } from "./submitter.js";
import { AnalyticsReport, SignedAttestation } from "./types.js";
import { logger } from "./logger.js";
import { rateLimiter, initRateLimiter } from "./middleware/rate-limiter.js";
import { createHealthRouter } from "./routes/health.js";
import { validateParams } from "./middleware/validate.js";
import { AttestationCache } from "./attestation-cache.js";
import { z } from "zod";
import { notFoundError, isAppError } from "@linkora/types/src/errors.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const SOROBAN_RPC_URL = requireEnv("SOROBAN_RPC_URL");
const CONTRACT_ID = requireEnv("CONTRACT_ID");
const ORACLE_PRIVATE_KEY_HEX = requireEnv("ORACLE_PRIVATE_KEY_HEX");
const ORACLE_NAME = process.env["ORACLE_NAME"] ?? "default";
const WINDOW_LEDGERS = BigInt(process.env["WINDOW_LEDGERS"] ?? "1000");
const PORT = parseInt(process.env["PORT"] ?? "4000", 10);
const NETWORK_PASSPHRASE = process.env["NETWORK_PASSPHRASE"] ?? "Test SDF Network ; September 2015";
const ATTESTATION_CACHE_MAX_SIZE = parseInt(
  process.env["ATTESTATION_CACHE_MAX_SIZE"] ?? "10000",
  10
);
const ATTESTATION_CACHE_TTL_MS = parseInt(process.env["ATTESTATION_CACHE_TTL_MS"] ?? "3600000", 10);

const oraclePrivateKey = Buffer.from(ORACLE_PRIVATE_KEY_HEX, "hex");
const oracleKeypair = Keypair.fromRawEd25519Seed(oraclePrivateKey);

const db = new Pool({ connectionString: DATABASE_URL });

const attestationCache = new AttestationCache<SignedAttestation>({
  maxSize: ATTESTATION_CACHE_MAX_SIZE,
  ttlMs: ATTESTATION_CACHE_TTL_MS,
});

let lastWindowEnd = BigInt(0);

function generateRequestId(): string {
  return randomUUID();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

async function runWindow(windowStart: bigint, windowEnd: bigint): Promise<void> {
  logger.info(
    { windowStart: windowStart.toString(), windowEnd: windowEnd.toString() },
    "Computing analytics for ledger window"
  );

  const stats = await fetchCreatorStats(db, windowStart, windowEnd);
  if (stats.length === 0) {
    logger.info(
      { windowStart: windowStart.toString(), windowEnd: windowEnd.toString() },
      "No active creators in window, skipping"
    );
    return;
  }

  for (const s of stats) {
    let creatorBytes: Uint8Array;
    try {
      creatorBytes = Keypair.fromPublicKey(s.creatorAddress).rawPublicKey();
    } catch {
      logger.warn({ creatorAddress: s.creatorAddress }, "Skipping invalid address");
      continue;
    }

    const report: AnalyticsReport = {
      version: 1,
      creator: creatorBytes,
      windowStart,
      windowEnd,
      totalTips: s.totalTips,
      postCount: s.postCount,
      followerDelta: s.followerDelta,
      uniqueTippers: s.uniqueTippers,
    };

    const reportCbor = encodeReport(report);
    const { signature, reportHash } = signReport(reportCbor, oraclePrivateKey);

    let txHash: string;
    try {
      txHash = await submitAttestation(
        SOROBAN_RPC_URL,
        NETWORK_PASSPHRASE,
        CONTRACT_ID,
        ORACLE_NAME,
        reportCbor,
        signature,
        oracleKeypair,
        s.creatorAddress,
        windowStart,
        windowEnd
      );
      logger.info({ creatorAddress: s.creatorAddress, txHash }, "Creator attested");
    } catch (err) {
      logger.error({ creatorAddress: s.creatorAddress, err }, "Attestation submission failed");
      continue;
    }

    attestationCache.set(s.creatorAddress, {
      oracleName: ORACLE_NAME,
      reportCbor,
      reportHash: reportHash.toString("hex"),
      signature,
      txHash,
      report,
      submittedAt: Date.now(),
    });
  }
}

async function scheduleLoop(currentLedger: bigint): Promise<void> {
  const windowStart =
    lastWindowEnd === BigInt(0) ? currentLedger - WINDOW_LEDGERS : lastWindowEnd + BigInt(1);
  const windowEnd = currentLedger;

  if (windowEnd <= windowStart) {
    return;
  }

  lastWindowEnd = windowEnd;
  await runWindow(windowStart, windowEnd);
}

const app = express();
app.use(helmet());
app.set("trust proxy", 1); // trust first proxy
const startTime = Date.now();

let started = false;
let startedAt: string | null = null;

function markStarted(): void {
  if (started) return;
  started = true;
  startedAt = new Date().toISOString();
}

function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const existing = req.headers["x-request-id"];
  const raw = Array.isArray(existing) ? existing[0] : existing;
  const id = (typeof raw === "string" ? raw : null) ?? generateRequestId();
  req.requestId = id;
  next();
}

// ── Health endpoints ──────────────────────────────────────────────────────────
// Liveness / readiness / startup probes — see routes/health.ts for details.

app.use(requestIdMiddleware);

app.use(
  createHealthRouter({
    db,
    rpcUrl: SOROBAN_RPC_URL,
    startTime,
    isStarted: () => started,
    startedAt: () => startedAt,
  })
);

// Per-IP rate limiting applied to attestation-serving endpoints. See
// services/analytics-oracle/src/middleware/rate-limiter.ts and config.ts.
app.use(rateLimiter);

const creatorParamsSchema = z.object({
  creator: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address format"),
});

app.get("/attestations/:creator", validateParams(creatorParamsSchema), (req, res) => {
  const { creator } = req.params;
  const att = attestationCache.get(creator as string);
  if (!att) {
    const err = notFoundError("no attestation found for this creator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.status(err.statusCode).json(err.toJSON((req as any).requestId));
    return;
  }

  res.json({
    oracleName: att.oracleName,
    reportHash: att.reportHash,
    reportCbor: att.reportCbor.toString("hex"),
    signature: att.signature.toString("hex"),
    txHash: att.txHash,
    submittedAt: att.submittedAt,
    report: {
      version: att.report.version,
      creator: Buffer.from(att.report.creator).toString("hex"),
      windowStart: att.report.windowStart.toString(),
      windowEnd: att.report.windowEnd.toString(),
      totalTips: att.report.totalTips.toString(),
      postCount: att.report.postCount.toString(),
      followerDelta: att.report.followerDelta.toString(),
      uniqueTippers: att.report.uniqueTippers,
    },
  });
});

app.get("/metrics/cache", (_req, res) => {
  res.json(attestationCache.getStats());
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((err: Error, req: any, res: Response, _next: NextFunction): void => {
  logger.error({ requestId: req.requestId, err }, "Unhandled error");

  const statusCode = isAppError(err) ? err.statusCode : 500;
  const code = isAppError(err) ? err.code : "INTERNAL_ERROR";
  const message = process.env.NODE_ENV === "development" ? err.message : "Internal server error";

  res.status(statusCode).json({
    error: {
      code,
      message,
      requestId: req.requestId,
    },
  });
});

async function main(): Promise<void> {
  const pubkeyHex = Buffer.from(ed.getPublicKey(oraclePrivateKey)).toString("hex");
  logger.info(
    {
      pubkeyHex,
      stellarAddress: oracleKeypair.publicKey(),
      contractId: CONTRACT_ID,
      windowLedgers: WINDOW_LEDGERS.toString(),
      cacheMaxSize: ATTESTATION_CACHE_MAX_SIZE,
      cacheTtlMs: ATTESTATION_CACHE_TTL_MS,
    },
    "Oracle starting"
  );

  // Initialise rate limiter (upgrades to Redis store when REDIS_URL is set).
  await initRateLimiter();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Oracle API listening");
    markStarted();
  });

  const pollMs = Number(WINDOW_LEDGERS) * 5_000;
  logger.info({ pollIntervalMs: pollMs }, "Oracle polling interval set");

  // Periodically sweep stale TTL entries so memory is reclaimed even for
  // creators that are never queried again after their attestation is stored.
  // Run every quarter of the TTL (minimum every 5 minutes).
  const purgeIntervalMs = Math.max(ATTESTATION_CACHE_TTL_MS / 4, 5 * 60 * 1000);
  setInterval(() => {
    const evicted = attestationCache.purgeExpired();
    if (evicted > 0) {
      logger.info({ evicted, ...attestationCache.getStats() }, "Attestation cache TTL sweep");
    }
  }, purgeIntervalMs).unref(); // unref so the timer does not prevent clean shutdown

  const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
  const server = new StellarRpc.Server(SOROBAN_RPC_URL);

  const tick = async () => {
    try {
      const info = await server.getLatestLedger();
      await scheduleLoop(BigInt(info.sequence));
    } catch (err) {
      logger.error({ err }, "Oracle tick error");
    }
  };

  await tick();
  setInterval(tick, pollMs);
}

main().catch((err) => {
  logger.error({ err }, "Oracle fatal error");
  process.exit(1);
});
