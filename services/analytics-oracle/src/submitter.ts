import {
  rpc,
  Contract,
  nativeToScVal,
  TransactionBuilder,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";
import { logger } from "./logger.js";

const DEFAULT_TIMEOUT = 30;

// ── Retry support ─────────────────────────────────────────────────────────────

/** Node/undici error codes that indicate a transient network failure. */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface RetryMetrics {
  /** Total submission attempts (including first tries). */
  attempts: number;
  /** Total retries performed after a transient failure. */
  retries: number;
  /** Submissions that succeeded after at least one retry. */
  successesAfterRetry: number;
  /** Submissions that failed after exhausting all retries. */
  exhaustedRetries: number;
  /** Submissions that failed with a non-transient error (never retried). */
  nonTransientFailures: number;
}

export const retryMetrics: RetryMetrics = {
  attempts: 0,
  retries: 0,
  successesAfterRetry: 0,
  exhaustedRetries: 0,
  nonTransientFailures: 0,
};

/** Reset retry metrics (for tests). */
export function resetRetryMetrics(): void {
  retryMetrics.attempts = 0;
  retryMetrics.retries = 0;
  retryMetrics.successesAfterRetry = 0;
  retryMetrics.exhaustedRetries = 0;
  retryMetrics.nonTransientFailures = 0;
}

/**
 * Classify an error as transient (worth retrying) or not.
 *
 * Transient: network-level failures (connection reset/refused, DNS, timeout)
 * and 5xx responses from the RPC server.
 *
 * Non-transient: simulation errors (the transaction itself is invalid —
 * retrying cannot succeed) and anything else we cannot positively identify
 * as a temporary infrastructure problem.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();

  // Simulation failures mean the transaction is invalid — never retry.
  if (message.includes("simulat")) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  const code: unknown = anyErr.code ?? anyErr.cause?.code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;

  const status: unknown = anyErr.status ?? anyErr.response?.status;
  if (typeof status === "number" && status >= 500 && status < 600) return true;

  if (message.includes("timeout") || message.includes("timed out")) return true;
  if (message.includes("socket hang up") || message.includes("network")) return true;
  if (/\b5\d{2}\b/.test(message) && message.includes("status")) return true;

  return false;
}

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. */
  maxRetries?: number;
  /** Base backoff delay in ms; doubles on each retry (1s, 2s, 4s by default). */
  baseDelayMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra fields to include in retry log lines. */
  logContext?: Record<string, unknown>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying on transient errors with exponential backoff.
 *
 * Non-transient errors (e.g. simulation failures) are thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const logContext = options.logContext ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    retryMetrics.attempts++;
    try {
      const result = await fn();
      if (attempt > 0) {
        retryMetrics.successesAfterRetry++;
        logger.info({ ...logContext, attempt: attempt + 1 }, "Submission succeeded after retry");
      }
      return result;
    } catch (err) {
      lastError = err;

      if (!isTransientError(err)) {
        retryMetrics.nonTransientFailures++;
        logger.error(
          { ...logContext, attempt: attempt + 1, err },
          "Non-transient submission error — not retrying"
        );
        throw err;
      }

      if (attempt === maxRetries) {
        retryMetrics.exhaustedRetries++;
        logger.error(
          { ...logContext, attempts: attempt + 1, err },
          "Submission failed after exhausting retries"
        );
        throw err;
      }

      const delayMs = baseDelayMs * 2 ** attempt;
      retryMetrics.retries++;
      logger.warn(
        {
          ...logContext,
          attempt: attempt + 1,
          maxRetries,
          retryInMs: delayMs,
          err,
        },
        "Transient submission error — retrying with backoff"
      );
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop always returns or throws. Keeps TypeScript happy.
  throw lastError;
}

// ── Submission ────────────────────────────────────────────────────────────────

export async function submitAttestation(
  rpcUrl: string,
  networkPassphrase: string,
  contractId: string,
  oracleName: string,
  reportCbor: Buffer,
  signature: Buffer,
  oracleKeypair: Keypair,
  creatorAddress: string,
  windowStart: bigint,
  windowEnd: bigint
): Promise<string> {
  const server = new rpc.Server(rpcUrl);

  // The whole flow is rebuilt on each attempt so the source account sequence
  // number is refreshed and the transaction is re-simulated and re-signed.
  return withRetry(
    async () => {
      const op = new Contract(contractId).call(
        "verify_analytics_attestation",
        nativeToScVal(oracleName, { type: "symbol" }),
        nativeToScVal(reportCbor, { type: "bytes" }),
        xdr.ScVal.scvBytes(signature),
        nativeToScVal(creatorAddress, { type: "address" }),
        nativeToScVal(windowStart, { type: "u64" }),
        nativeToScVal(windowEnd, { type: "u64" })
      );

      const sourceAccount = await server.getAccount(oracleKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: "1000",
        networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(DEFAULT_TIMEOUT)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(oracleKeypair);
      const result = await server.sendTransaction(prepared);
      await server.pollTransaction(result.hash);
      return result.hash;
    },
    { logContext: { creatorAddress, windowStart: windowStart.toString() } }
  );
}
