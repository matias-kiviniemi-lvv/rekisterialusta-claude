/**
 * Forms platform service (Architecture §5.4).
 *
 * Two form types, one validation discipline:
 *   - case form: updates a subset of a registry's fields (create-if-empty for
 *     citizen-initiated matters). If the form requires approval and the
 *     submitter is a customer, the change is STAGED in pending_case_updates and
 *     applied only on worker approval — because a citizen-supplied value can
 *     have legal effect. Worker submissions apply immediately.
 *   - operation form: creates an operation, its payload validated against a
 *     stored JSON schema, optionally carrying file attachments (to blob store,
 *     reference only in DB).
 *
 * This is an application service: it spans shared config (form defs), registry
 * data, authorization, and blob storage. It keeps the domain modules pure.
 */

import type { Platform, RegistryHandle } from "../api/platform.ts";
import type { Principal } from "../api/authz.ts";
import type { Db } from "../db/db.ts";
import type { RegistryFieldDef } from "../config/registry-catalog.ts";
import { getCaseByDiaryNumber } from "../core/queries.ts";
import { workerCanAccessCategory, customerOwnsCase } from "../core/authorization.ts";
import { createCase } from "../domain/cases.ts";
import { appendOperation } from "../domain/operations.ts";
import { validate, type ObjectSchema } from "../domain/json-schema.ts";
import { blobKey } from "../blob/blob.ts";

export interface ServiceResult {
  readonly status: number;
  readonly body: unknown;
}

interface FormDef {
  formId: string;
  registryId: string;
  kind: "case" | "operation";
  audience: "worker" | "customer";
  requiresApproval: boolean;
  fieldSubset: string[] | null;
  propertySchema: ObjectSchema | null;
  allowAttachments: boolean;
  operationType: string | null;
}

async function loadForm(shared: Db, registryId: string, formId: string): Promise<FormDef | undefined> {
  const row = await shared.get(
    "SELECT * FROM form_definitions WHERE form_id = ? AND registry_id = ? AND active = 1",
    [formId, registryId],
  );
  if (!row) return undefined;
  return {
    formId: String(row.form_id),
    registryId: String(row.registry_id),
    kind: row.kind as "case" | "operation",
    audience: row.audience as "worker" | "customer",
    requiresApproval: Number(row.requires_approval) === 1,
    fieldSubset: row.field_subset ? (JSON.parse(String(row.field_subset)) as string[]) : null,
    propertySchema: row.property_schema ? (JSON.parse(String(row.property_schema)) as ObjectSchema) : null,
    allowAttachments: Number(row.allow_attachments) === 1,
    operationType: row.operation_type === null ? null : String(row.operation_type),
  };
}

function submitterKind(p: Principal): "worker" | "customer" | "system" | "public" {
  if (p.kind === "public") return "public";
  if (p.kind === "token") return "system";
  return p.actor.kind;
}

export async function submitForm(
  platform: Platform,
  h: RegistryHandle,
  formId: string,
  principal: Principal,
  body: Record<string, unknown>,
  now: string,
): Promise<ServiceResult> {
  const form = await loadForm(platform.shared, h.def.registryId, formId);
  if (!form) return { status: 404, body: { error: "unknown form" } };

  const who = submitterKind(principal);
  if (who === "public") return { status: 403, body: { error: "authentication required" } };
  // Audience gating: a customer form is for customers, a worker form for workers.
  if (form.audience === "customer" && who !== "customer")
    return { status: 403, body: { error: "customer form" } };
  if (form.audience === "worker" && who !== "worker")
    return { status: 403, body: { error: "worker form" } };

  return form.kind === "case"
    ? submitCaseForm(platform, h, form, principal, body, now)
    : submitOperationForm(platform, h, form, principal, body, now);
}

async function submitCaseForm(
  platform: Platform,
  h: RegistryHandle,
  form: FormDef,
  principal: Principal,
  body: Record<string, unknown>,
  now: string,
): Promise<ServiceResult> {
  const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as Record<string, unknown>;
  // Only fields in the form's declared subset may be touched (§5.4).
  const allowed = new Set(form.fieldSubset ?? h.def.fields.map((f) => f.name));
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) return { status: 400, body: { error: `field "${key}" not allowed by this form` } };
  }
  const typeErr = validateFieldTypes(h.def.fields, fields);
  if (typeErr) return { status: 400, body: { error: typeErr } };

  const diaryNumber = body.diaryNumber ? String(body.diaryNumber) : "";

  // Create-if-empty: no diary number → open a new case (citizen-initiated).
  if (!diaryNumber) {
    const category = String(body.category ?? "");
    const initialState = String(body.initialState ?? "");
    if (!category || !initialState) return { status: 400, body: { error: "category and initialState required to create a case" } };
    const actorId = principal.kind === "actor" && principal.actor.kind === "customer" ? principal.actor.customerId : "";
    const parties = actorId ? [{ customerId: actorId, role: "applicant" }] : [];
    const created = await createCase(
      h.db,
      {
        registryId: h.def.registryId, diaryFormat: h.def.diary, fieldDefs: h.def.fields,
        year: Number(body.year ?? new Date(now).getUTCFullYear()),
        category, initialState,
        fields: fields as Record<string, string | number | boolean | null>,
        parties, actorKind: who(principal), actorId,
      },
      now,
    );
    return { status: 201, body: { diaryNumber: created.diaryNumber, applied: true } };
  }

  const c = await getCaseByDiaryNumber(h.db, diaryNumber);
  if (!c) return { status: 404, body: { error: "case not found" } };

  // Authorization to update this specific case.
  if (principal.kind === "actor" && principal.actor.kind === "worker") {
    if (!(await workerCanAccessCategory(platform.shared, principal.actor.workerId, c.category, "write")))
      return { status: 403, body: { error: "forbidden" } };
  } else if (principal.kind === "actor" && principal.actor.kind === "customer") {
    if (!(await customerOwnsCase(platform.shared, h.db, c.caseKey, principal.actor.customerId)))
      return { status: 403, body: { error: "forbidden" } };
  }

  const isCustomer = principal.kind === "actor" && principal.actor.kind === "customer";
  if (form.requiresApproval && isCustomer) {
    // Stage, do not apply (§5.4 approval workflow).
    await h.db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO pending_case_updates (case_key, form_id, payload, submitted_by, submitted_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
        [c.caseKey, form.formId, JSON.stringify(fields), (principal.actor as { customerId: string }).customerId, now],
      );
      await appendOperation(tx, { caseKey: c.caseKey, direction: "incoming", type: "pending_submission", properties: { formId: form.formId }, actorKind: "customer", actorId: (principal.actor as { customerId: string }).customerId }, now);
    });
    return { status: 202, body: { staged: true, requiresApproval: true } };
  }

  // Apply immediately.
  await applyCaseFields(h.db, c.caseKey, fields, now, who(principal), actorIdOf(principal), form.formId);
  return { status: 200, body: { applied: true } };
}

async function submitOperationForm(
  platform: Platform,
  h: RegistryHandle,
  form: FormDef,
  principal: Principal,
  body: Record<string, unknown>,
  now: string,
): Promise<ServiceResult> {
  const diaryNumber = String(body.diaryNumber ?? "");
  if (!diaryNumber) return { status: 400, body: { error: "diaryNumber required" } };
  const c = await getCaseByDiaryNumber(h.db, diaryNumber);
  if (!c) return { status: 404, body: { error: "case not found" } };

  // Authorization.
  if (principal.kind === "actor" && principal.actor.kind === "worker") {
    if (!(await workerCanAccessCategory(platform.shared, principal.actor.workerId, c.category, "write")))
      return { status: 403, body: { error: "forbidden" } };
  } else if (principal.kind === "actor" && principal.actor.kind === "customer") {
    if (!(await customerOwnsCase(platform.shared, h.db, c.caseKey, principal.actor.customerId)))
      return { status: 403, body: { error: "forbidden" } };
  }

  // Validate payload against the form's JSON schema (§5.4).
  const payload = (body.properties && typeof body.properties === "object" ? body.properties : {}) as Record<string, unknown>;
  if (form.propertySchema) {
    const res = validate(form.propertySchema, payload);
    if (!res.valid) return { status: 400, body: { error: "payload invalid", details: res.errors } };
  }

  const attachments = Array.isArray(body.attachments) ? (body.attachments as Array<Record<string, unknown>>) : [];
  if (attachments.length > 0 && !form.allowAttachments)
    return { status: 400, body: { error: "this form does not accept attachments" } };

  const result = await h.db.transaction(async (tx) => {
    const op = await appendOperation(
      tx,
      {
        caseKey: c.caseKey,
        direction: "incoming",
        type: form.operationType ?? "form_submission",
        properties: payload,
        actorKind: who(principal),
        actorId: actorIdOf(principal),
      },
      now,
    );
    for (const a of attachments) {
      const filename = String(a.filename ?? "file");
      const contentType = String(a.contentType ?? "application/octet-stream");
      const bytes = Buffer.from(String(a.base64 ?? ""), "base64");
      const stored = platform.blobs.put(blobKey(h.def.registryId, c.caseKey, filename), new Uint8Array(bytes));
      await tx.run(
        "INSERT INTO attachments (case_key, operation_key, filename, content_type, size, blob_key, checksum, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [c.caseKey, op.operationKey, filename, contentType, stored.size, stored.key, stored.checksum, now],
      );
    }
    return op;
  });
  return { status: 201, body: { operationId: result.operationId, attachments: attachments.length } };
}

export async function decidePending(
  platform: Platform,
  h: RegistryHandle,
  pendingId: number,
  decision: "approved" | "rejected",
  principal: Principal,
  now: string,
): Promise<ServiceResult> {
  // Only a worker with approve permission on the case category may decide.
  if (!(principal.kind === "actor" && principal.actor.kind === "worker"))
    return { status: 403, body: { error: "worker authentication required" } };
  const workerId = principal.actor.workerId;

  const pending = await h.db.get("SELECT pending_id, case_key, payload, status FROM pending_case_updates WHERE pending_id = ?", [pendingId]);
  if (!pending) return { status: 404, body: { error: "pending update not found" } };
  if (String(pending.status) !== "pending") return { status: 409, body: { error: "already decided" } };

  const caseKey = BigInt(pending.case_key as number);
  const caseRow = await h.db.get("SELECT category FROM cases WHERE case_key = ?", [caseKey]);
  const category = String(caseRow?.category ?? "");
  if (!(await workerCanAccessCategory(platform.shared, workerId, category, "approve")))
    return { status: 403, body: { error: "forbidden" } };

  await h.db.transaction(async (tx) => {
    await tx.run("UPDATE pending_case_updates SET status = ?, decided_by = ?, decided_at = ? WHERE pending_id = ?", [decision, workerId, now, pendingId]);
    if (decision === "approved") {
      const fields = JSON.parse(String(pending.payload)) as Record<string, unknown>;
      await applyCaseFieldsTx(tx, caseKey, fields, now, "worker", workerId, "approval");
    } else {
      await appendOperation(tx, { caseKey, direction: "internal", type: "submission_rejected", actorKind: "worker", actorId: workerId }, now);
    }
  });
  return { status: 200, body: { decision } };
}

// ---- field application helpers --------------------------------------------

function validateFieldTypes(defs: readonly RegistryFieldDef[], values: Record<string, unknown>): string | undefined {
  const byName = new Map(defs.map((d) => [d.name, d] as const));
  for (const [name, v] of Object.entries(values)) {
    const def = byName.get(name);
    if (!def) return `unknown field "${name}"`;
    if (v === null) {
      if (!def.nullable) return `field "${name}" may not be null`;
      continue;
    }
    const ok =
      (def.type === "text" && typeof v === "string") ||
      (def.type === "integer" && typeof v === "number" && Number.isInteger(v)) ||
      (def.type === "decimal" && typeof v === "number") ||
      (def.type === "date" && typeof v === "string") ||
      (def.type === "boolean" && typeof v === "boolean");
    if (!ok) return `field "${name}" has wrong type (expected ${def.type})`;
  }
  return undefined;
}

async function applyCaseFields(db: RegistryHandle["db"], caseKey: bigint, fields: Record<string, unknown>, now: string, actorKind: "worker" | "customer" | "system", actorId: string, formId: string): Promise<void> {
  await db.transaction(async (tx) => await applyCaseFieldsTx(tx, caseKey, fields, now, actorKind, actorId, formId));
}

async function applyCaseFieldsTx(tx: Db, caseKey: bigint, fields: Record<string, unknown>, now: string, actorKind: "worker" | "customer" | "system", actorId: string, formId: string): Promise<void> {
  const names = Object.keys(fields);
  if (names.length > 0) {
    const setClause = names.map((n) => `${n} = ?`).join(", ");
    const values = names.map((n) => {
      const v = fields[n];
      return typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
    });
    await tx.run(`UPDATE cases SET ${setClause}, modified = ? WHERE case_key = ?`, [...values, now, caseKey]);
  }
  await appendOperation(tx, { caseKey, direction: "internal", type: "case_updated", properties: { formId, fields: Object.keys(fields) }, actorKind, actorId }, now);
}

// ---- principal helpers -----------------------------------------------------

function who(p: Principal): "worker" | "customer" | "system" {
  if (p.kind === "actor" && p.actor.kind === "worker") return "worker";
  if (p.kind === "actor" && p.actor.kind === "customer") return "customer";
  return "system";
}
function actorIdOf(p: Principal): string {
  if (p.kind === "actor" && p.actor.kind === "worker") return p.actor.workerId;
  if (p.kind === "actor" && p.actor.kind === "customer") return p.actor.customerId;
  if (p.kind === "token") return p.scope.tokenId;
  return "";
}
