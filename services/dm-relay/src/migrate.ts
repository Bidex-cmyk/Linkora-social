/**
 * Database migration runner for DM relay service.
 *
 * Reads and executes SQL migration files from the migrations/ directory
 * in lexicographic order. Uses the same DATABASE_URL env var as the main
 * service.
 *
 * Usage: pnpm db:migrate
 */

import { Pool } from "pg";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found in", MIGRATIONS_DIR);
      return;
    }

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`Running migration: ${file}`);
      await pool.query(sql);
      console.log(`  Done.`);
    }

    console.log(`Migrations complete (${files.length} file(s) executed).`);
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
