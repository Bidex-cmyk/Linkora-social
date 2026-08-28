import { Pool, QueryConfig, QueryResult, QueryResultRow, PoolConfig } from "pg";
import { logger } from "./logger";

/**
 * A `pg.Pool` subclass that measures every query's wall-clock duration and
 * emits a structured warning through the shared logger when the duration
 * exceeds `slowQueryThresholdMs`.
 *
 * Replaces the previous monkey-patch of `pgPool.query` which:
 *   - cast the pool to `any`, removing TypeScript overload safety
 *   - silently dropped results when the 2-argument callback form was used
 *   - had no error-path instrumentation
 */
export class InstrumentedPool extends Pool {
  private readonly slowQueryThresholdMs: number;

  constructor(slowQueryThresholdMs: number, config?: PoolConfig) {
    super(config);
    this.slowQueryThresholdMs = slowQueryThresholdMs;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    const start = Date.now();
    const sqlSnippet =
      typeof queryTextOrConfig === "string"
        ? queryTextOrConfig.slice(0, 120)
        : "(prepared)";
    try {
      const result = await super.query<R>(queryTextOrConfig as string, values);
      const dur = Date.now() - start;
      if (dur > this.slowQueryThresholdMs) {
        logger.warn({ dur, sql: sqlSnippet }, "slow-query");
      }
      return result;
    } catch (err) {
      const dur = Date.now() - start;
      logger.error({ dur, sql: sqlSnippet, err }, "query-error");
      throw err;
    }
  }
}
