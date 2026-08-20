/**
 * Operations service (Architecture §2.3).
 *
 * Operations are the append-only history of a case. This module only ever
 * INSERTs; it never updates payloads. operation_id is the human-facing 1..n
 * sequence within a case, allocated from the current max under the same
 * transaction as the insert. Every actor (worker/customer/system) is stamped
 * for audit, so machine actions are as traceable as human ones.
 */

import type { Db } from "../db/db.ts";

export type Direction = "incoming" | "outgoing" | "internal";
export type ActorKind = "worker" | "customer" | "system";

export interface AppendOperationInput {
  readonly caseKey: bigint;
  readonly direction: Direction;
  readonly type: string;
  readonly subtype?: string | undefined;
  readonly properties?: unknown; // serialized to JSON
  readonly comment?: string | undefined;
  readonly actorKind: ActorKind;
  readonly actorId?: string | undefined;
}

export interface OperationRecord {
  readonly operationKey: bigint;
  readonly operationId: number;
}

export async function appendOperation(tx: Db, input: AppendOperationInput, now: string): Promise<OperationRecord> {
  const seqRow = await tx.get(
    "SELECT COALESCE(MAX(operation_id), 0) AS max_id FROM operations WHERE case_key = ?",
    [input.caseKey],
  );
  const operationId = Number(seqRow?.max_id ?? 0) + 1;

  const res = await tx.run(
    `
    INSERT INTO operations
      (case_key, operation_id, created, modified, direction, type, subtype, properties, comment, actor_kind, actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.caseKey,
      operationId,
      now,
      now,
      input.direction,
      input.type,
      input.subtype ?? null,
      input.properties === undefined ? null : JSON.stringify(input.properties),
      input.comment ?? null,
      input.actorKind,
      input.actorId ?? null,
    ],
  );

  return { operationKey: res.lastInsertRowId, operationId };
}
