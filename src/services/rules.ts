/**
 * Rule engine (Architecture §9, Decision D-07).
 *
 * Evaluates on state change: when a case reaches a state, active rules for the
 * registry whose (optional) target-state matches are evaluated; where a rule's
 * condition holds, its action runs. Actions are a FIXED catalog plus three
 * PARAMETERIZED actions (set_state, update_values, create_operation) — no
 * arbitrary code. Every action is recorded as an operation, and a rule-driven
 * set_state routes through the state-machine service, so a rule can neither
 * bypass the allowed-transition rule nor escape the audit trail.
 *
 * Cascade safety: a set_state action may re-trigger rules; recursion is capped
 * at MAX_CASCADE to prevent infinite loops.
 */

import type { Platform, RegistryHandle } from "../api/platform.ts";
import type { Db, DbAdapter } from "../db/db.ts";
import { appendOperation } from "../domain/operations.ts";
import { changeState, IllegalTransitionError } from "../domain/state-machine.ts";
import { isWithin } from "../domain/categories.ts";
import type { Condition } from "../domain/rule-types.ts";

const MAX_CASCADE = 5;

interface RuleRow {
  ruleId: string;
  onToState: string | null;
  condition: Condition;
  actionType: string;
  actionParams: Record<string, unknown>;
}

export async function runRulesForStateChange(
  platform: Platform,
  h: RegistryHandle,
  caseKey: bigint,
  toState: string,
  depth = 0,
): Promise<number> {
  if (depth > MAX_CASCADE) return 0;

  const rules = await loadRules(platform.shared, h.def.registryId, toState);
  let fired = 0;

  for (const rule of rules) {
    const caseRow = await h.db.get("SELECT * FROM cases WHERE case_key = ?", [caseKey]);
    if (!caseRow) break;
    if (!evalCondition(rule.condition, caseRow)) continue;
    await executeAction(platform, h, caseKey, rule, depth);
    fired++;
  }
  return fired;
}

async function loadRules(shared: Db, registryId: string, toState: string): Promise<RuleRow[]> {
  const rows = await shared.all(
    `SELECT rule_id, on_to_state, condition, action_type, action_params
       FROM rules
      WHERE registry_id = ? AND active = 1 AND [trigger] = 'state_change'
        AND (on_to_state IS NULL OR on_to_state = ?)
      ORDER BY ordering, rule_id`,
    [registryId, toState],
  );
  return rows.map((r) => ({
    ruleId: String(r.rule_id),
    onToState: r.on_to_state === null ? null : String(r.on_to_state),
    condition: r.condition ? (JSON.parse(String(r.condition)) as Condition) : null,
    actionType: String(r.action_type),
    actionParams: r.action_params ? (JSON.parse(String(r.action_params)) as Record<string, unknown>) : {},
  }));
}

function evalCondition(cond: Condition, caseRow: Record<string, unknown>): boolean {
  if (cond === null) return true;
  if ("all" in cond) return cond.all.every((c) => evalCondition(c, caseRow));
  if ("any" in cond) return cond.any.some((c) => evalCondition(c, caseRow));
  if ("categoryWithin" in cond) return isWithin(String(caseRow.category), cond.categoryWithin);
  if ("equals" in cond) return normalize(caseRow[cond.field]) === normalize(cond.equals);
  if ("notEquals" in cond) return normalize(caseRow[cond.field]) !== normalize(cond.notEquals);
  return false;
}

// SQLite stores booleans as 0/1; normalize so {equals: true} matches a stored 1.
function normalize(v: unknown): unknown {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

async function executeAction(platform: Platform, h: RegistryHandle, caseKey: bigint, rule: RuleRow, depth: number): Promise<void> {
  const now = platform.clock.now();
  const p = rule.actionParams;

  switch (rule.actionType) {
    case "set_state": {
      const toState = String(p.toState ?? "");
      try {
        await changeState(h.db, { caseKey, toState, actorKind: "system", actorId: `rule:${rule.ruleId}` }, now);
        // Cascade: the new state may trigger further rules (bounded).
        await runRulesForStateChange(platform, h, caseKey, toState, depth + 1);
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) throw err;
        await recordAction(h.db, caseKey, rule, { skipped: "illegal transition", toState }, now);
      }
      return;
    }
    case "update_values": {
      const fields = (p.fields && typeof p.fields === "object" ? p.fields : {}) as Record<string, unknown>;
      await h.db.transaction(async (tx) => {
        const names = Object.keys(fields);
        if (names.length > 0) {
          const setClause = names.map((n) => `${n} = ?`).join(", ");
          const values = names.map((n) => {
            const v = fields[n];
            return typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
          });
          await tx.run(`UPDATE cases SET ${setClause}, modified = ? WHERE case_key = ?`, [...values, now, caseKey]);
        }
        await appendOperation(tx, { caseKey, direction: "internal", type: "rule_update_values", properties: { ruleId: rule.ruleId, fields }, actorKind: "system", actorId: `rule:${rule.ruleId}` }, now);
      });
      return;
    }
    case "create_operation": {
      await h.db.transaction(async (tx) => {
        await appendOperation(
          tx,
          {
            caseKey,
            direction: (String(p.direction ?? "internal") as "incoming" | "outgoing" | "internal"),
            type: String(p.type ?? "rule_operation"),
            subtype: p.subtype === undefined ? undefined : String(p.subtype),
            properties: p.properties,
            comment: p.comment === undefined ? undefined : String(p.comment),
            actorKind: "system",
            actorId: `rule:${rule.ruleId}`,
          },
          now,
        );
      });
      return;
    }
    default: {
      // Fixed catalog actions with external side effects (notify_customer,
      // send_to_integration, export, …). In this foundation they are recorded
      // as operations; the queue-backed execution arrives in Phase 4. This is
      // where an action would be enqueued (outbox), never run inline.
      await recordAction(h.db, caseKey, rule, { action: rule.actionType, params: p }, now);
      return;
    }
  }
}

async function recordAction(db: DbAdapter, caseKey: bigint, rule: RuleRow, properties: unknown, now: string): Promise<void> {
  await db.transaction(async (tx) =>
    await appendOperation(tx, { caseKey, direction: "outgoing", type: "rule_action", subtype: rule.actionType, properties, actorKind: "system", actorId: `rule:${rule.ruleId}` }, now),
  );
}
