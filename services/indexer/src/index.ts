/**
/**
 * Linkora Indexer — entry point.
 *
 * Connects to a Soroban RPC endpoint and streams Linkora contract events
 * through an exactly-once pipeline:
 *
 *   RPC getEvents → stream (rate-limited, adaptive, gap-aware)
 *                 → IngestPipeline (raw_events + domain write + cursor, 1 txn)
 *                 → EventBus → WebSocket fanout (/ws)
 *
 * Environment variables (all required unless noted):
 *   DATABASE_URL            - PostgreSQL connection string
 *   STELLAR_RPC_URL         - Soroban RPC endpoint
 *   CONTRACT_ID             - Bech32 contract address
 *   START_LEDGER            - Ledger sequence to start streaming from
 *   PORT                    - (optional) HTTP/WS port, default 3000
 *   RPC_RATE_LIMIT_PER_SEC  - (optional) RPC rate cap, default 10
 *   MIN_POLL_INTERVAL_MS    - (optional) adaptive poll floor, default 100
 *   MAX_POLL_INTERVAL_MS    - (optional) adaptive poll ceiling, default 5000
 */

import http from "http";
import { Pool } from "pg";
import { streamEvents, backfillStartupGap, RawEvent, BatchProcessor } from "./stream";
import { IngestPipeline, IngestEvent } from "./pipeline";
import { bus } from "./bus";
import { attachWebSocketServer } from "./ws";
import { startGossip } from "./gossip";
import { attachNotificationDispatcher } from "./notifications/events";
import { NotificationService, PostgresDeviceTokenStore } from "./notifications/service";
import { createApp } from "./api";
import { createDomainProcessor } from "./domain-processor";
import { PostgresDatabase } from "./postgres-db";
import { ScoreRefreshService } from "./score-refresh";
import { HealthMonitor } from "./services/health-monitor";

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalIntEnv(name: string): number | undefined {
  const v = process.env[name];
  return v ? parseInt(v, 10) : undefined;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const STELLAR_RPC_URL = requireEnv("STELLAR_RPC_URL");
const CONTRACT_ID = requireEnv("CONTRACT_ID");
const START_LEDGER = parseInt(requireEnv("START_LEDGER"), 10);
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SCORE_REFRESH_INTERVAL_MINUTES = parseInt(
  process.env.SCORE_REFRESH_INTERVAL_MINUTES ?? "5",
  10
);
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "30000", 10);

// ── Database ──────────────────────────────────────────────────────────────────

const pgPool = new Pool({ connectionString: DATABASE_URL });
const notificationService = new NotificationService({
  deviceTokenStore: new PostgresDeviceTokenStore(pgPool),
  pool: pgPool,
});
const scoreRefreshService = new ScoreRefreshService(pgPool, SCORE_REFRESH_INTERVAL_MINUTES);

/**
 * Idempotently ensure the staging table and cursor exist. Mirrors
 * migrations/006_raw_events.sql for dev/test environments that boot without a
 * separate migration step.
 */
async function ensureSchema(): Promise<void> {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id              BIGSERIAL   NOT NULL,
      ledger_sequence BIGINT      NOT NULL,
      event_index     INT         NOT NULL,
      contract_id     TEXT        NOT NULL,
      topic           TEXT[]      NOT NULL,
      data            JSONB       NOT NULL,
      processed_at    TIMESTAMPTZ,
      PRIMARY KEY (ledger_sequence, event_index)
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id               TEXT        PRIMARY KEY,
      processed_cursor BIGINT      NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      ledger_sequence BIGINT      PRIMARY KEY,
      state_root      TEXT        NOT NULL,
      computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id         SERIAL      PRIMARY KEY,
      address    TEXT        NOT NULL,
      token      TEXT        NOT NULL,
      platform   TEXT        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (address, token)
    )
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_device_tokens_address_updated
      ON device_tokens (address, updated_at DESC)
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS sent_notifications (
      id              BIGSERIAL    PRIMARY KEY,
      event_id        BIGINT       NOT NULL,
      event_type      TEXT         NOT NULL,
      recipient       TEXT         NOT NULL,
      dispatch_key    TEXT         NOT NULL,
      dispatched_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (dispatch_key)
    )
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_sent_notifications_recipient
      ON sent_notifications (recipient, dispatched_at DESC)
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      blocker TEXT NOT NULL,
      blocked TEXT NOT NULL,
      PRIMARY KEY (blocker, blocked)
    )
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks (blocker)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked)
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS dm_keys (
      address       TEXT PRIMARY KEY,
      x25519_pubkey TEXT NOT NULL,
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      address              TEXT PRIMARY KEY,
      browser_push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      new_followers        BOOLEAN NOT NULL DEFAULT TRUE,
      new_likes            BOOLEAN NOT NULL DEFAULT TRUE,
      new_comments         BOOLEAN NOT NULL DEFAULT TRUE,
      direct_messages      BOOLEAN NOT NULL DEFAULT TRUE,
      pool_activity        BOOLEAN NOT NULL DEFAULT TRUE,
      governance_updates   BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Event normalisation ─────────────────────────────────────────────────────

function toIngestEvent(event: RawEvent): IngestEvent {
  return {
    ledgerSequence: event.ledger,
    eventIndex: event.eventIndex,
    contractId: event.contractId,
    type: event.topic[0] ?? "unknown",
    topic: event.topic,
    data: {
      id: event.id,
      value: event.value,
      txHash: event.txHash,
      ledgerClosedAt: event.ledgerClosedAt,
      pagingToken: event.pagingToken,
    },
  };
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

const healthMonitor = new HealthMonitor(pgPool, STELLAR_RPC_URL);
const apiApp = createApp(new PostgresDatabase(pgPool), pgPool, healthMonitor);
const httpServer = http.createServer(apiApp);

const wsHandle = attachWebSocketServer(httpServer, bus, { path: "/ws" });
const detachNotificationDispatcher = attachNotificationDispatcher(bus, pgPool, notificationService);

// ── Lifecycle control ────────────────────────────────────────────────────────

const abortController = new AbortController();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[indexer] Received ${signal}, shutting down…`);
  healthMonitor.markShuttingDown();
  abortController.abort();
  scoreRefreshService.stop();
  detachNotificationDispatcher();
  await wsHandle.close();
  httpServer.close();
  await pgPool.end();
  console.log("[indexer] Shutdown complete.");
}

gracefulShutdown.registerSignals();

// ── Core runner ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("Starting Linkora indexer");
  logger.info(
    { rpcUrl: STELLAR_RPC_URL, contractId: CONTRACT_ID, startLedger: START_LEDGER },
    "Config"
  );

  await ensureSchema();

  const pipeline = new IngestPipeline(pgPool, {
    streamId: CONTRACT_ID,
    bus,
    domainProcessor: createDomainProcessor(
      pgPool,
      notificationService,
      new PostgresDatabase(pgPool)
    ),
  });

  const processBatch: BatchProcessor = async (events) => {
    const result = await pipeline.processBatch(events.map(toIngestEvent));
    if (events.length > 0) healthMonitor.recordEvent();
    return result.cursor;
  };

  // Resume gap detection from the last committed cursor.
  const initialCursor = await pipeline.readCursor();

  // ── Startup gap detection ─────────────────────────────────────────────────
  // If the indexer was down, fetch the current ledger from RPC and backfill
  // any ledgers between processed_cursor and current before streaming live.
  if (initialCursor > 0) {
    try {
      const rpcRes = await fetch(STELLAR_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
      });
      if (rpcRes.ok) {
        const rpcJson = (await rpcRes.json()) as { result?: { sequence: number } };
        const currentLedger = rpcJson.result?.sequence ?? 0;
        if (currentLedger > initialCursor + 1) {
          logger.info(
            { processedCursor: initialCursor, currentLedger },
            "Startup gap detected, backfilling"
          );
          await backfillStartupGap(
            { rpcUrl: STELLAR_RPC_URL, contractId: CONTRACT_ID },
            initialCursor + 1,
            currentLedger,
            processBatch,
            abortController.signal
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "Startup gap check failed (continuing)");
    }
  }

  httpServer.listen(PORT, () => {
    console.log(`[indexer] HTTP + WS listening on :${PORT} (ws path /ws)`);
    healthMonitor.markStarted();
  });

  // Start score refresh service
  scoreRefreshService.start();

  // Start gossip in the background.
  startGossip(pgPool, abortController.signal).catch((err) =>
    logger.error({ err }, "Gossip fatal error")
  );

  await streamEvents(
    {
      rpcUrl: STELLAR_RPC_URL,
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      initialCursor,
      ratePerSec: optionalIntEnv("RPC_RATE_LIMIT_PER_SEC"),
      minPollMs: optionalIntEnv("MIN_POLL_INTERVAL_MS"),
      maxPollMs: optionalIntEnv("MAX_POLL_INTERVAL_MS"),
    },
    processBatch,
    abortController.signal
  );

  logger.info("Event stream ended, initiating shutdown");
  await gracefulShutdown.shutdown("stream_end");
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
