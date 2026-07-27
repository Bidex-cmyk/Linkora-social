/**
 * DM Relay Server - Transport-only encrypted message relay for Linkora.
 *
 * This server never has access to plaintext message content. All messages
 * are end-to-end encrypted using X25519 + ChaCha20-Poly1305.
 */

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { Database } from "./database";
import { AuthService } from "./auth";
import { CleanupService } from "./cleanup";
import { createRouter, registerWsClient } from "./routes";
import { loadConfig } from "./config";
import {
  requestIdMiddleware,
  requestLoggerMiddleware,
  errorHandler,
  notFoundHandler,
  validateContentType,
} from "./middleware";
import { messageAuthMiddleware, addressOwnershipMiddleware } from "./middleware/auth";
import { rateLimitMiddleware, initRateLimiters } from "./middleware/rateLimit";
import { createHealthRouter } from "./routes/health";
import { logger } from "./logger";

// Load environment variables
dotenv.config();

const SERVICE_VERSION = process.env.npm_package_version ?? "0.1.0";
const startTime = Date.now();

// Configuration
const config = loadConfig();

let started = false;
let startedAt: string | null = null;
let shuttingDown = false;

async function createApp() {
  const app = express();
  app.set("trust proxy", 1); // trust first proxy

  // Security middleware
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  // CORS configuration
  app.use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Idempotency-Key"],
      credentials: false, // No cookies/credentials needed
    })
  );

  // Body parsing
  app.use(express.json({ limit: "1mb" })); // Limit request size

  // Initialize database
  logger.info({ service: "dm-relay" }, "Connecting to database...");
  const database = new Database(config.databaseUrl);
  await database.init();

  // Initialize auth service
  const authService = new AuthService(config.maxTimestampSkew, config.stellarNetwork);

  // Initialize cleanup service
  const cleanupService = new CleanupService(
    database,
    config.messageTtlDays,
    config.idempotencyTtlHours
  );
  cleanupService.start();

  // Initialise rate limiters (upgrades to Redis store when REDIS_URL is set).
  await initRateLimiters();

  // Custom middleware
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(validateContentType);

  // Rate limiting
  app.use("/api", rateLimitMiddleware);

  // API routes with auth middleware
  const messageAuth = messageAuthMiddleware(authService);
  const addressAuth = addressOwnershipMiddleware(authService);
  app.use("/api", (req, res, next) => {
    // POST /messages — verify message signature
    if (req.method === "POST" && req.path === "/messages") {
      return messageAuth(req, res, next);
    }
    // GET /messages/:address — verify address ownership
    if (req.method === "GET" && /^\/messages\/[A-Z]/.test(req.path)) {
      return addressAuth(req, res, next);
    }
    next();
  });
  app.use("/api", createRouter(database, authService));

  // ── Health endpoints ───────────────────────────────────────────────────────
  // Liveness / readiness / startup probes — see routes/health.ts for details.

  app.use(
    createHealthRouter({
      db: database,
      startTime,
      isStarted: () => started,
      startedAt: () => startedAt,
      isShuttingDown: () => shuttingDown,
    })
  );

  // Root info
  app.get("/", (_req, res) => {
    res.json({ service: "linkora-dm-relay", version: SERVICE_VERSION, status: "running" });
  });

  // Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  // WebSocket server for real-time push to online recipients
  // Clients connect with ?address=<STELLAR_ADDRESS>&timestamp=<TS>&signature=<SIG>
  // to authenticate and receive their messages.
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const MAX_WS_CONNECTIONS_PER_ADDRESS = 5;
  const WS_RATE_LIMIT_WINDOW_MS = 60_000;
  const WS_RATE_LIMIT_MAX = 30;
  const wsConnectionCounts = new Map<string, number>();
  const wsIpRateLimit = new Map<string, { count: number; resetAt: number }>();

  function getWsClientIp(req: http.IncomingMessage): string {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") return xff.split(",")[0].trim();
    return req.socket.remoteAddress || "unknown";
  }

  function isWsIpRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = wsIpRateLimit.get(ip);
    if (!entry || now > entry.resetAt) {
      wsIpRateLimit.set(ip, { count: 1, resetAt: now + WS_RATE_LIMIT_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > WS_RATE_LIMIT_MAX;
  }

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const clientIp = getWsClientIp(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const address = url.searchParams.get("address") ?? "";
    const timestampStr = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";

    // Rate limit per IP
    if (isWsIpRateLimited(clientIp)) {
      logger.warn({ ip: clientIp }, "WebSocket rate limit exceeded");
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    // Validate required auth params
    if (!address || !timestampStr || !signature) {
      ws.close(1008, "Missing required query params: address, timestamp, signature");
      return;
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      ws.close(1008, "Invalid timestamp");
      return;
    }

    // Verify address ownership
    try {
      authService.verifyAddressOwnership(address, timestamp, signature);
    } catch (err) {
      logger.warn({ ip: clientIp, address }, "WebSocket auth failed");
      ws.close(1008, "Authentication failed");
      return;
    }

    // Enforce max connections per address
    const currentCount = wsConnectionCounts.get(address) ?? 0;
    if (currentCount >= MAX_WS_CONNECTIONS_PER_ADDRESS) {
      logger.warn({ address, count: currentCount }, "WebSocket connection limit reached");
      ws.close(1008, "Maximum connections per address reached");
      return;
    }

    wsConnectionCounts.set(address, currentCount + 1);
    registerWsClient(address, ws);

    logger.info(
      { address, ip: clientIp, connections: currentCount + 1 },
      "WebSocket client connected (authenticated)"
    );

    ws.on("close", () => {
      const count = wsConnectionCounts.get(address) ?? 1;
      if (count <= 1) {
        wsConnectionCounts.delete(address);
      } else {
        wsConnectionCounts.set(address, count - 1);
      }
      logger.info({ address, ip: clientIp }, "WebSocket client disconnected");
    });
  });

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, "Starting graceful shutdown...");
    shuttingDown = true;

    wss.close();
    cleanupService.stop();
    await database.close();

    logger.info("Graceful shutdown completed");
    process.exit(0);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  return { app: httpServer, database, cleanupService };
}

async function startServer() {
  try {
    const { app: httpServer } = await createApp();

    const server = httpServer.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.nodeEnv, ttlDays: config.messageTtlDays },
        "DM Relay service started"
      );
      started = true;
      startedAt = new Date().toISOString();
    });

    return server;
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

export { createApp, startServer };
