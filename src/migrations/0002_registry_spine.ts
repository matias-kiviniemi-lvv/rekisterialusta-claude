/**
 * Migration 0002 — per-registry case/operation spine (Architecture §2.3, §4).
 *
 * This is a FACTORY: the cases table includes the registry's statutory fields
 * as real typed columns generated from the field configuration (Decision D-03),
 * so each registry gets a different-but-typed spine from the same code. That is
 * why "add a statutory field" is a migration, not a UI action.
 *
 * Identity PKs and generated column types come from the Dialect, so the spine
 * is built correctly on SQLite and SQL Server. The remaining static columns
 * (TEXT/INTEGER) are translated for T-SQL by the SQL Server adapter's DDL pass.
 *
 * Spine tables:
 *   - cases:             internal BIGINT key + public diary number (D-01/D-02)
 *   - operations:        append-only history (§2.3)
 *   - states:            configurable lifecycle states (§4)
 *   - state_transitions: the "managed set of allowed changes" (§4)
 *   - case_handlers:     assignees/roles per case
 *   - case_parties:      customer ownership links for authorization (§6.2)
 */

import type { Migration } from "./runner.ts";
import type { RegistryDefinition } from "../config/registry-catalog.ts";

export function registrySpineMigration(reg: RegistryDefinition): Migration {
  return {
    id: "0002",
    name: `registry_spine:${reg.registryId}`,
    async up(tx, d) {
      // Registry-specific statutory columns, typed, from configuration (D-03).
      const fieldCols = reg.fields
        .map((f) => `        ${f.name} ${d.columnType(f.type)}${f.nullable ? "" : " NOT NULL"}`)
        .join(",\n");

      await tx.run(`
        CREATE TABLE states (
          id                      TEXT PRIMARY KEY,
          name                    TEXT NOT NULL,
          description             TEXT NULL,
          is_open                 INTEGER NOT NULL DEFAULT 1,
          is_waiting_for_customer INTEGER NOT NULL DEFAULT 0
        )
      `);

      await tx.run(`
        CREATE TABLE state_transitions (
          from_state         TEXT NOT NULL REFERENCES states(id),
          to_state           TEXT NOT NULL REFERENCES states(id),
          allowed_actor_kind TEXT NULL,
          PRIMARY KEY (from_state, to_state)
        )
      `);

      // case_key is the internal surrogate PK; diary_number is the PUBLIC id and
      // is unique per registry — NOT the primary key (Decision D-01/D-02).
      await tx.run(`
        CREATE TABLE cases (
          ${d.identityPk("case_key")},
          diary_number  TEXT NOT NULL UNIQUE,
          created       TEXT NOT NULL,
          modified      TEXT NOT NULL,
          category      TEXT NOT NULL,
          state         TEXT NOT NULL REFERENCES states(id),
          is_published  INTEGER NOT NULL DEFAULT 0${fieldCols ? ",\n" + fieldCols : ""}
        )
      `);
      await tx.run("CREATE INDEX ix_cases_category ON cases(category)");
      await tx.run("CREATE INDEX ix_cases_state ON cases(state)");

      // Append-only history. operation_id is the human 1..n sequence per case.
      await tx.run(`
        CREATE TABLE operations (
          ${d.identityPk("operation_key")},
          case_key      ${d.columnType("integer")} NOT NULL REFERENCES cases(case_key),
          operation_id  INTEGER NOT NULL,
          created       TEXT NOT NULL,
          modified      TEXT NOT NULL,
          direction     TEXT NOT NULL CHECK (direction IN ('incoming','outgoing','internal')),
          type          TEXT NOT NULL,
          subtype       TEXT NULL,
          properties    TEXT NULL,
          comment       TEXT NULL,
          actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('worker','customer','system')),
          actor_id      TEXT NULL,
          UNIQUE (case_key, operation_id)
        )
      `);
      await tx.run("CREATE INDEX ix_operations_case ON operations(case_key)");

      await tx.run(`
        CREATE TABLE case_handlers (
          case_key  ${d.columnType("integer")} NOT NULL REFERENCES cases(case_key),
          worker_id TEXT NOT NULL,
          role      TEXT NOT NULL,
          PRIMARY KEY (case_key, worker_id, role)
        )
      `);

      await tx.run(`
        CREATE TABLE case_parties (
          case_key    ${d.columnType("integer")} NOT NULL REFERENCES cases(case_key),
          customer_id TEXT NOT NULL,
          party_role  TEXT NOT NULL,
          PRIMARY KEY (case_key, customer_id, party_role)
        )
      `);
      await tx.run("CREATE INDEX ix_case_parties_customer ON case_parties(customer_id)");

      // Gapless per-year diary numbering source (D-01), in the registry's own
      // database so allocation shares the case-insert transaction.
      await tx.run(`
        CREATE TABLE diary_counters (
          registry_id TEXT NOT NULL,
          year        INTEGER NOT NULL,
          last_number INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (registry_id, year)
        )
      `);
    },
  };
}
