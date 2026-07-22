/**
 * Health check orchestration for Kubernetes-style liveness / readiness / startup probes.
 *
 * Tracks process-level lifecycle state (started, shutting down) and runs
 * downstream dependency checks (database, Stellar RPC, event stream) with
 * latency measurements for the readiness probe.
 */

import { Pool } from "pg";

export interface DependencyCheck {
  status: "up" | "down";
  latencyMs: number;
}

export interface EventStreamCheck {
  status: "connected" | "disconnected";
  lastEventAgo: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: DependencyCheck;
    stellar_rpc: DependencyCheck;
    event_stream: EventStreamCheck;
  };
}

export class HealthMonitor {
  private started = false;
  private startedAt: string | null = null;
  private shuttingDown = false;
  private lastEventAt: number | null = null;

  constructor(
    private db: Pool,
    private rpcUrl: string
  ) {}

  markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = new Date().toISOString();
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  recordEvent(): void {
    this.lastEventAt = Date.now();
  }

  isStarted(): boolean {
    return this.started;
  }

  getStartedAt(): string | null {
    return this.startedAt;
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    const start = Date.now();
    try {
      await this.db.query("SELECT 1");
      return { status: "up", latencyMs: Date.now() - start };
    } catch {
      return { status: "down", latencyMs: Date.now() - start };
    }
  }

  private async checkStellarRpc(): Promise<DependencyCheck> {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      await fetch(this.rpcUrl, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
      }).finally(() => clearTimeout(timeout));
      return { status: "up", latencyMs: Date.now() - start };
    } catch {
      return { status: "down", latencyMs: Date.now() - start };
    }
  }

  private checkEventStream(): EventStreamCheck {
    if (this.lastEventAt === null) {
      return { status: "disconnected", lastEventAgo: "n/a" };
    }
    const secondsAgo = Math.floor((Date.now() - this.lastEventAt) / 1000);
    return { status: "connected", lastEventAgo: `${secondsAgo}s` };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    if (this.shuttingDown) {
      return {
        ready: false,
        checks: {
          database: { status: "down", latencyMs: 0 },
          stellar_rpc: { status: "down", latencyMs: 0 },
          event_stream: { status: "disconnected", lastEventAgo: "n/a" },
        },
      };
    }

    const [database, stellar_rpc] = await Promise.all([
      this.checkDatabase(),
      this.checkStellarRpc(),
    ]);
    const event_stream = this.checkEventStream();

    const ready = database.status === "up" && stellar_rpc.status === "up";
    return { ready, checks: { database, stellar_rpc, event_stream } };
  }
}
