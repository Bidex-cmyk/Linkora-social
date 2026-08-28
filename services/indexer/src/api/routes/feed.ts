import { Router, Request, Response } from "express";
import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { validateParams, validateQuery } from "../../middleware/validate";
import { z } from "zod";
import { stellarAddressSchema, cursorPaginationSchema } from "@linkora/types/src/schemas";

const exploreQuerySchema = cursorPaginationSchema.extend({
  cursor: z.coerce.number().optional(),
});

const followingFeedParamsSchema = z.object({
  address: stellarAddressSchema,
});

const followingFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/**
 * Run a read-only query against the post_scores materialized view, retrying
 * once on transient lock contention. A CONCURRENTLY refresh briefly holds an
 * exclusive lock on the view; readers that arrive mid-swap can hit a lock
 * timeout (55P03) and should retry rather than fail the request.
 */
async function queryView<R extends QueryResultRow = QueryResultRow>(
  pg: Pool,
  text: string,
  params: unknown[]
): Promise<QueryResult<R>> {
  try {
    return await pg.query<R>(text, params);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const isTransient =
      code === "55P03" || code === "57014" || code === "40P01" || code === "40001";
    if (!isTransient) throw err;
    // Briefly wait for the refresh to release the lock, then retry once.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return await pg.query<R>(text, params);
  }
}

export function createFeedRouter(pg: Pool): Router {
  const router = Router();

  router.get(
    "/explore",
    validateQuery(exploreQuerySchema),
    async (req: Request, res: Response): Promise<void> => {
      const { limit, cursor } = req.query as unknown as z.infer<typeof exploreQuerySchema>;

      let query = `
        SELECT 
          id,
          author,
          content,
          tip_total,
          like_count,
          created_at,
          score
        FROM post_scores
      `;
      const params: (number | string)[] = [];
      let paramIndex = 1;

      if (cursor !== undefined) {
        query += ` WHERE score < $${paramIndex}`;
        params.push(cursor);
        paramIndex++;
      }

      query += ` ORDER BY score DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await queryView(pg, query, params);

      res.json({
        posts: result.rows.map((row) => ({
          id: row.id,
          author: row.author,
          content: row.content,
          tip_total: row.tip_total,
          like_count: row.like_count,
          created_at: row.created_at,
          score: row.score,
        })),
        has_more: result.rows.length === limit,
        next_cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].score : null,
      });
    }
  );

  router.get(
    "/following/:address",
    validateParams(followingFeedParamsSchema),
    validateQuery(followingFeedQuerySchema),
    async (req: Request, res: Response): Promise<void> => {
      const address = req.params.address;
      const { limit, cursor } = req.query as unknown as z.infer<typeof followingFeedQuerySchema>;

      let query = `
        SELECT
          p.id,
          p.author,
          p.content,
          p.tip_total,
          p.like_count,
          p.created_at
        FROM posts p
        INNER JOIN follows f ON p.author = f.followee
        WHERE f.follower = $1
          AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = p.author)
          AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker = p.author AND blocked = $1)
      `;
      const params: (string | Date)[] = [address];
      let paramIndex = 2;

      if (cursor !== undefined) {
        query += ` AND p.created_at < $${paramIndex}`;
        params.push(new Date(cursor));
        paramIndex++;
      }

      query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex}`;
      params.push(String(limit));

      const result = await pg.query(query, params);

      res.json({
        posts: result.rows.map((row) => ({
          id: row.id,
          author: row.author,
          content: row.content,
          tip_total: row.tip_total,
          like_count: row.like_count,
          created_at: row.created_at,
        })),
        has_more: result.rows.length === limit,
        next_cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].created_at : null,
      });
    }
  );

  return router;
}
