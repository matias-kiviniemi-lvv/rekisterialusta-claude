/**
 * State-machine service (Architecture §4).
 *
 * The SINGLE code path allowed to change a case's state. It verifies a
 * configured transition exists, applies the change, and writes the transition
 * to history — all in one transaction, so state and history never diverge.
 * Rule-engine "set state" actions route through here too (Decision D-07), so
 * automation cannot bypass the allowed-transition rule.
 *
 * Authorization (worker category / customer ownership) is layered by the
 * platform core before this is called; the actorKind/actorId are recorded here
 * for the audit trail.
 */

import type { DbAdapter } from "../db/db.ts";
import { appendOperation, type ActorKind } from "./operations.ts";

export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`No allowed transition from "${from}" to "${to}"`);
    this.name = "IllegalTransitionError";
  }
}

export interface ChangeStateInput {
  readonly caseKey: bigint;
  readonly toState: string;
  readonly actorKind: ActorKind;
  readonly actorId?: string | undefined;
  readonly comment?: string | undefined;
}

export async function changeState(db: DbAdapter, input: ChangeStateInput, now: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await tx.get("SELECT state FROM cases WHERE case_key = ?", [input.caseKey]);
    if (!current) throw new Error(`Case ${input.caseKey} not found`);
    const fromState = String(current.state);

    const allowed = await tx.get(
      "SELECT 1 AS ok FROM state_transitions WHERE from_state = ? AND to_state = ?",
      [fromState, input.toState],
    );
    if (!allowed) throw new IllegalTransitionError(fromState, input.toState);

    await tx.run("UPDATE cases SET state = ?, modified = ? WHERE case_key = ?", [
      input.toState,
      now,
      input.caseKey,
    ]);

    await appendOperation(
      tx,
      {
        caseKey: input.caseKey,
        direction: "internal",
        type: "state_change",
        properties: { from: fromState, to: input.toState },
        comment: input.comment ?? "",
        actorKind: input.actorKind,
        actorId: input.actorId ?? "",
      },
      now,
    );
  });
}
