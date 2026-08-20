/**
 * Forward-only, ordered, idempotent migration runner (Decision D-05).
 *
 * Migrations are numbered and applied in order; each is recorded in
 * schema_migrations. Applying twice is a no-op. There is deliberately no
 * "down"/rollback in production: recovery is roll-forward with a compensating
 * migration, so history is never mutated. The same runner is parameterized by
 * registry so per-registry migrations apply across the whole set.
 *
 * Each migration receives the active Dialect so its DDL (identity columns,
 * types, create-if-not-exists) targets SQLite or SQL Server without branching.
 */

import type { Db, DbAdapter } from "../db/db.ts";
import { dialectFor, type Dialect } from "../db/dialect.ts";

export interface Migration {
  /** Zero-padded ordering id, e.g. "0001". Must be unique and sortable. */
  readonly id: string;
  /** Short description for the migration log. */
  readonly name: string;
  /** Applies the change. Runs inside a transaction supplied by the runner. */
  up(tx: Db, d: Dialect): Promise<void>;
}

async function ensureMigrationsTable(db: DbAdapter, d: Dialect): Promise<void> {
  await db.run(
    d.createTableIfNotExists(
      "schema_migrations",
      `id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL`,
    ),
  );
}

async function appliedIds(db: DbAdapter): Promise<Set<string>> {
  const rows = await db.all("SELECT id FROM schema_migrations ORDER BY id");
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * Apply all not-yet-applied migrations in id order.
 * `now` is injected so runs are deterministic and testable.
 * Returns the ids that were applied this run.
 */
export async function migrate(db: DbAdapter, migrations: readonly Migration[], now: string): Promise<string[]> {
  const d = dialectFor(db.dialect);
  await ensureMigrationsTable(db, d);
  const done = await appliedIds(db);
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));

  // Guard against duplicate ids — a common config-as-code mistake.
  const seen = new Set<string>();
  for (const m of ordered) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
    seen.add(m.id);
  }

  const applied: string[] = [];
  for (const m of ordered) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await m.up(tx, d);
      await tx.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        m.id,
        m.name,
        now,
      ]);
    });
    applied.push(m.id);
  }
  return applied;
}
