import { Pool, PoolConfig } from "pg";
import { logger } from "./logger";

/**
 * A `pg.Pool` subclass that measures every query's wall-clock duration and
 * emits a structured warning through the shared logger when the duration
 * exceeds `slowQueryThresholdMs`.
 */
export class InstrumentedPool extends Pool {
  private readonly slowQueryThresholdMs: number;

  constructor(slowQueryThresholdMs: number, config?: PoolConfig) {
    super(config);
    this.slowQueryThresholdMs = slowQueryThresholdMs;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query<R extends any = any, I extends any[] = any[]>(...args: any[]): any {
    const start = Date.now();
    const queryTextOrConfig = args[0];
    const sqlSnippet =
      typeof queryTextOrConfig === "string"
        ? queryTextOrConfig.slice(0, 120)
        : "(prepared)";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (super.query as any)(...args);
      if (res && typeof res.then === "function") {
        return res
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((result: any) => {
            const dur = Date.now() - start;
            if (dur > this.slowQueryThresholdMs) {
              logger.warn({ dur, sql: sqlSnippet }, "slow-query");
            }
            return result;
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch((err: any) => {
            const dur = Date.now() - start;
            logger.error({ dur, sql: sqlSnippet, err }, "query-error");
            throw err;
          });
      }
      return res;
    } catch (err) {
      const dur = Date.now() - start;
      logger.error({ dur, sql: sqlSnippet, err }, "query-error");
      throw err;
    }
  }
}
