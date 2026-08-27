/**
 * Linkora Analytics Oracle
 *
 * Runs on a ledger-window schedule:
 *   1. Queries the indexer PostgreSQL DB for per-creator activity in the window.
 *   2. Encodes each creator's analytics as a CBOR report.
 *   3. Signs the SHA-256 of the CBOR with the oracle Ed25519 key.
 *   4. Submits `verify_analytics_attestation` to the Soroban contract.
 *   5. Caches the latest signed attestation per creator.
 *
 * Exposes GET /attestations/:creator returning the latest signed report + signature.
 */

import express from "express";
import { Pool } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { rateLimit } from "express-rate-limit";
import { encodeReport } from "./codec.js";
import { signReport } from "./signer.js";
import { fetchCreatorStats } from "./db.js";
import { submitAttestation } from "./submitter.js";
import { AnalyticsReport, SignedAttestation } from "./types.js";
import { logger } from "./logger.js";

// Wire sha512 for @noble/ed25519 synchronous API
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ── Config ────────────────────────────────────────────────────────────────────

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

// ── Init ──────────────────────────────────────────────────────────────────────

const oraclePrivateKey = Buffer.from(ORACLE_PRIVATE_KEY_HEX, "hex");
// Stellar keypair derived from the same 32-byte seed for fee payment.
const oracleKeypair = Keypair.fromRawEd25519Seed(oraclePrivateKey);

const db = new Pool({ connectionString: DATABASE_URL });

// In-memory cache: creator address -> latest attestation
const attestationCache = new Map<string, SignedAttestation>();

// ── Analytics loop ────────────────────────────────────────────────────────────

let lastWindowEnd = BigInt(0);

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
    // Decode the creator's Stellar address to its raw 32-byte public key.
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

    // Submit on-chain.
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

    // Cache for API.
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

// ── REST API ──────────────────────────────────────────────────────────────────

const app = express();
const SERVICE_VERSION = process.env["npm_package_version"] ?? "0.1.0";
const COMMIT_SHA = process.env["COMMIT_SHA"] ?? "unknown";
const startTime = Date.now();

// ── Health endpoints ──────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  let dbStatus = "disconnected";
  try {
    await db.query("SELECT 1");
    dbStatus = "connected";
  } catch {
    /* */
  }

  let rpcStatus = "unreachable";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(SOROBAN_RPC_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: [] }),
    }).finally(() => clearTimeout(t));
    rpcStatus = "reachable";
  } catch {
    /* */
  }

  const ok = dbStatus === "connected" && rpcStatus === "reachable";
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    uptime,
    version: SERVICE_VERSION,
    commit: COMMIT_SHA,
    db: dbStatus,
    rpc: rpcStatus,
  });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not ready", reason: "db unavailable" });
  }
});

app.get("/health/live", (_req, res) => {
  res.json({ status: "live" });
});

import { getClientIP } from "./ip.js";

const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || "100", 10);

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: RATE_LIMIT_RPM,
  keyGenerator: (req) => (req as { stellarAddress?: string }).stellarAddress || getClientIP(req),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too Many Requests",
      code: "RATE_LIMIT_EXCEEDED",
    });
  },
});

app.use(apiLimiter);

/**
 * GET /attestations/:creator
 * Returns the latest signed attestation for a creator address.
 */
app.get("/attestations/:creator", (req, res) => {
  const att = attestationCache.get(req.params["creator"] ?? "");
  if (!att) {
    res.status(404).json({ error: "no attestation found for this creator" });
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

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pubkeyHex = Buffer.from(ed.getPublicKey(oraclePrivateKey)).toString("hex");
  logger.info(
    {
      pubkeyHex,
      stellarAddress: oracleKeypair.publicKey(),
      contractId: CONTRACT_ID,
      windowLedgers: WINDOW_LEDGERS.toString(),
    },
    "Oracle starting"
  );

  app.listen(PORT, () => logger.info({ port: PORT }, "Oracle API listening"));

  // Poll every WINDOW_LEDGERS * 5s for simplicity. In production, subscribe
  // to the indexer's event bus WebSocket for exact ledger-close events.
  const pollMs = Number(WINDOW_LEDGERS) * 5_000;
  logger.info({ pollIntervalMs: pollMs }, "Oracle polling interval set");

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

  // Run once immediately, then on interval.
  await tick();
  setInterval(tick, pollMs);
}

main().catch((err) => {
  logger.error({ err }, "Oracle fatal error");
  process.exit(1);
});
