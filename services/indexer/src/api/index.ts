import express, { Request, Response, NextFunction } from "express";
import { Pool as PgPool } from "pg";
import { Database } from "../db";
import { logger } from "../logger";
import { rateLimit, rateLimitWrite } from "../middleware/rateLimit";
import { requireStellarAuth } from "../middleware/stellarAuth";
import { createProfilesRouter } from "./routes/profiles";
import { createPostsRouter } from "./routes/posts";
import { createFollowsRouter } from "./routes/follows";
import { createPoolsRouter } from "./routes/pools";
import { createStateRootRouter } from "./routes/stateRoot";
import { createNotificationsRouter } from "./routes/notifications";
import { createGovernanceRouter } from "./routes/governance";
import { createUsersRouter } from "./routes/users";
import { createFeedRouter } from "./routes/feed";
import { isFenced } from "../gossip";
import { getBackfillState } from "../stream";
import {
  defaultNotificationService,
  NotificationService,
  PostgresDeviceTokenStore,
} from "../notifications/service";
import { PostgresDatabase } from "../postgres-db";
import { HealthMonitor } from "../services/health-monitor";

export interface ShutdownState {
  isShuttingDown: () => boolean;
}

// ── CORS middleware ───────────────────────────────────────────────────────────

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (origin) {
    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
}

// ── App factory ───────────────────────────────────────────────────────────────

export function createApp(
  db: Database,
  pg?: PgPool,
  healthMonitor?: HealthMonitor
): express.Application {
  const app = express();
  app.use(express.json());
  app.use(corsMiddleware);

  const startTime = Date.now();
  const version = process.env.npm_package_version ?? "0.1.0";
  const commit = process.env.COMMIT_SHA ?? "unknown";
  const monitor =
    healthMonitor ?? (pg ? new HealthMonitor(pg, process.env.STELLAR_RPC_URL ?? "") : undefined);

  // ── Shutdown-aware middleware ──────────────────────────────────────────────

  app.use((_req: Request, res: Response, next: NextFunction): void => {
    if (shutdownState?.isShuttingDown()) {
      res.status(503).json({ error: "Service shutting down", code: "SHUTTING_DOWN" });
      return;
    }
    next();
  });

  // ── Health endpoints ───────────────────────────────────────────────────────

  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    if (shutdownState?.isShuttingDown()) {
      res.status(503).json({
        status: "shutting_down",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version,
        commit,
      });
      return;
    }

    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const backfill = getBackfillState();
    const readiness = monitor
      ? await monitor.checkReadiness()
      : { ready: false, checks: undefined };

    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? "ok" : "degraded",
      uptime,
      version,
      commit,
      checks: readiness.checks,
      backfill: backfill.active
        ? { active: true, fromLedger: backfill.fromLedger, toLedger: backfill.toLedger }
        : { active: false },
    });
  });

  // Liveness probe — always 200 while the process is running.
  app.get("/health/live", (_req: Request, res: Response): void => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    res.json({ status: "alive", uptime });
  });

  // Readiness probe — 200 when DB, Stellar RPC, and event stream are healthy.
  app.get("/health/ready", async (_req: Request, res: Response): Promise<void> => {
    if (!monitor) {
      res.status(503).json({ status: "not_ready", reason: "health monitor unavailable" });
      return;
    }
    const readiness = await monitor.checkReadiness();
    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? "ready" : "not_ready",
      checks: readiness.checks,
    });
  });

  // Startup probe — 200 only once initial bootstrap has completed.
  app.get("/health/startup", (_req: Request, res: Response): void => {
    if (monitor?.isStarted()) {
      res.json({ status: "started", startedAt: monitor.getStartedAt() });
    } else {
      res.status(503).json({ status: "starting" });
    }
  });

  // Apply rate limiting to all /api routes.
  app.use("/api", rateLimit);

  // Self-fencing middleware: stop serving when Byzantine majority detected.
  app.use("/api", (_req: Request, res: Response, next: NextFunction): void => {
    if (isFenced()) {
      res
        .status(503)
        .json({ error: "Node self-fenced: Byzantine divergence detected", code: "SELF_FENCED" });
      return;
    }
    next();
  });

  // ── Resource routes ────────────────────────────────────────────────────────
  app.use("/api/profiles", createProfilesRouter(db));
  app.use("/api/posts", createPostsRouter(db));
  app.use("/api/follows", createFollowsRouter(db));
  app.use("/api/pools", createPoolsRouter(db));
  app.use("/api/governance", createGovernanceRouter(db));
  app.use("/api/users", createUsersRouter(db));

  // Feed routes (requires pg pool)
  if (pg) {
    app.use("/api/feed", createFeedRouter(pg));
  }

  const notificationService = pg
    ? new NotificationService({ deviceTokenStore: new PostgresDeviceTokenStore(pg) })
    : defaultNotificationService;
  app.use("/api/notifications", createNotificationsRouter(notificationService));

  // State root endpoint (requires pg pool).
  if (pg) {
    app.use("/api/state-root", createStateRootRouter(pg));
  }

  // ── DM relay endpoint (write — requires Stellar auth + write rate limit) ───

  interface MessagePayload {
    recipientAddress: string;
    encryptedContent: string;
  }

  app.post(
    "/api/messages",
    requireStellarAuth,
    rateLimitWrite,
    (req: Request, res: Response): void => {
      const body = req.body as Partial<MessagePayload>;

      if (typeof body.recipientAddress !== "string" || body.recipientAddress.trim() === "") {
        res.status(400).json({ error: "recipientAddress is required", code: "INVALID_PAYLOAD" });
        return;
      }

      if (typeof body.encryptedContent !== "string" || body.encryptedContent.trim() === "") {
        res.status(400).json({ error: "encryptedContent is required", code: "INVALID_PAYLOAD" });
        return;
      }

      // TODO: persist and relay DM via Stellar contract.
      res.status(202).json({
        status: "accepted",
        from: req.context?.stellarAddress,
        to: body.recipientAddress,
      });
    }
  );

  // ── Error handler ─────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
    logger.error(
      {
        requestId: req.context?.requestId,
        error: err.message,
        stack: err.stack,
      },
      "Unhandled error"
    );
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });

  return app;
}

// ── Server bootstrap (skipped when imported in tests) ────────────────────────

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require("pg") as typeof import("pg");
  const DATABASE_URL = process.env.DATABASE_URL ?? "";
  const _stub = new Pool({ connectionString: DATABASE_URL }) as unknown as Database;
  const PORT = parseInt(process.env.PORT ?? "3001", 10);
  const databaseUrl = process.env.DATABASE_URL;
  const pg = databaseUrl ? new PgPool({ connectionString: databaseUrl }) : undefined;
  const apiApp = pg ? createApp(new PostgresDatabase(pg), pg) : createApp(_stub);

  apiApp.listen(PORT, () => {
    console.log(`Indexer API listening on port ${PORT}`);
    console.log(`Rate limit enabled: read limit is 60 RPM, write limit is 10 RPM`);
  });
}
