/**
 * REST route handlers (Architecture §5, §7).
 *
 * Handlers are pure functions of (platform, request) → response. They resolve
 * the target registry, authorize via authz.ts (never trusting the caller), then
 * use the domain services. No raw table access is ever exposed. This is the
 * machine surface AND what the portals call — one authorization model for both.
 *
 * Handlers are async because the DB seam is async.
 */

import type { Platform } from "./platform.ts";
import { defineRoute, type Route } from "./router.ts";
import type { Principal } from "./authz.ts";
import type { ApiRequest, ApiResponse, ApiHandler } from "./http-types.ts";
import { adminRoutes } from "./admin-routes.ts";
import { canReadCase, canWriteCase, canTransitionCase } from "./authz.ts";
import { getCaseByDiaryNumber, getCaseHistory, listCustomerCases, searchPublishedCases } from "../core/queries.ts";
import { authorizedCases, assignedCases, unassignedOptedInCases, pendingToApprove } from "../core/worker-queries.ts";
import { createCase } from "../domain/cases.ts";
import { appendOperation, type Direction } from "../domain/operations.ts";
import { changeState, IllegalTransitionError } from "../domain/state-machine.ts";
import { runRulesForStateChange } from "../services/rules.ts";
import { submitForm, decidePending } from "../services/forms.ts";
import { dialectFor } from "../db/dialect.ts";

export type { ApiRequest, ApiResponse, ApiHandler } from "./http-types.ts";

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

// ---- Case read -------------------------------------------------------------

const getCase: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  if (!(await canReadCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  return { status: 200, body: { case: { ...c, caseKey: Number(c.caseKey) }, history: await getCaseHistory(h.db, c.caseKey) } };
};

// ---- Case create -----------------------------------------------------------

const postCase: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const b = asObject(req.body);
  const category = String(b.category ?? "");
  const initialState = String(b.initialState ?? "");
  if (!category || !initialState) return { status: 400, body: { error: "category and initialState required" } };

  // Authorization for creation: workers need write on the category; customers
  // may create their own case; tokens need POST cases within scope.
  const p = req.principal;
  let actorKind: "worker" | "customer" | "system" = "system";
  let actorId = "";
  const parties: Array<{ customerId: string; role: string }> = Array.isArray(b.parties)
    ? (b.parties as Array<Record<string, unknown>>).map((x) => ({ customerId: String(x.customerId), role: String(x.role ?? "party") }))
    : [];

  if (p.kind === "actor" && p.actor.kind === "worker") {
    if (!(await workerWrite(platform, p.actor.workerId, category))) return { status: 403, body: { error: "forbidden" } };
    actorKind = "worker";
    actorId = p.actor.workerId;
  } else if (p.kind === "actor" && p.actor.kind === "customer") {
    actorKind = "customer";
    actorId = p.actor.customerId;
    // A customer is automatically a party to the case they open.
    if (!parties.some((x) => x.customerId === actorId)) parties.push({ customerId: actorId, role: "applicant" });
  } else if (p.kind === "token") {
    if (p.scope.registryId !== h.def.registryId || !tokenCreate(p, category)) return { status: 403, body: { error: "forbidden" } };
    actorKind = "system";
    actorId = p.scope.tokenId;
  } else {
    return { status: 403, body: { error: "forbidden" } };
  }

  try {
    const created = await createCase(
      h.db,
      {
        registryId: h.def.registryId,
        diaryFormat: h.def.diary,
        fieldDefs: h.def.fields,
        year: Number(b.year ?? new Date(platform.clock.now()).getUTCFullYear()),
        category,
        initialState,
        fields: asObject(b.fields) as Record<string, string | number | boolean | null>,
        parties,
        actorKind,
        actorId,
      },
      platform.clock.now(),
    );
    return { status: 201, body: { caseKey: Number(created.caseKey), diaryNumber: created.diaryNumber } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// small local wrappers to avoid importing internals widely
import { workerCanAccessCategory } from "../core/authorization.ts";
import { tokenAllows } from "./tokens.ts";
async function workerWrite(platform: Platform, workerId: string, category: string): Promise<boolean> {
  return workerCanAccessCategory(platform.shared, workerId, category, "write");
}
function tokenCreate(p: Extract<Principal, { kind: "token" }>, category: string): boolean {
  return tokenAllows(p.scope, "POST", "cases", category);
}

// ---- Operation append ------------------------------------------------------

const postOperation: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  if (!(await canWriteCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  const b = asObject(req.body);
  const { actorKind, actorId } = actorStamp(req.principal);
  const rec = await h.db.transaction((tx) =>
    appendOperation(
      tx,
      {
        caseKey: c.caseKey,
        direction: (String(b.direction ?? "internal") as Direction),
        type: String(b.type ?? "note"),
        subtype: b.subtype === undefined ? undefined : String(b.subtype),
        properties: b.properties,
        comment: b.comment === undefined ? undefined : String(b.comment),
        actorKind,
        actorId,
      },
      platform.clock.now(),
    ),
  );
  return { status: 201, body: { operationId: rec.operationId } };
};

// ---- State transition ------------------------------------------------------

const postTransition: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  if (!(await canTransitionCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  const b = asObject(req.body);
  const toState = String(b.toState ?? "");
  if (!toState) return { status: 400, body: { error: "toState required" } };
  const { actorKind, actorId } = actorStamp(req.principal);
  try {
    await changeState(h.db, { caseKey: c.caseKey, toState, actorKind, actorId, comment: b.comment === undefined ? undefined : String(b.comment) }, platform.clock.now());
    // Fire rules on the committed state change (§9).
    const fired = await runRulesForStateChange(platform, h, c.caseKey, toState);
    return { status: 200, body: { state: toState, rulesFired: fired } };
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { status: 409, body: { error: err.message } };
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// ---- Published search + my-cases -------------------------------------------

const getPublished: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const prefix = req.query.get("category") ?? undefined;
  return { status: 200, body: { cases: serializeCases(await searchPublishedCases(h.db, prefix)) } };
};

const getMyCases: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "customer")
    return { status: 403, body: { error: "customer authentication required" } };
  return { status: 200, body: { cases: serializeCases(await listCustomerCases(h.db, req.principal.actor.customerId)) } };
};

// ---- Forms (Phase 3) -------------------------------------------------------

const postFormSubmit: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  try {
    const result = await submitForm(platform, h, req.params.formId!, req.principal, asObject(req.body), platform.clock.now());
    return { status: result.status, body: result.body };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

const postPendingDecision: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const decision = req.params.decision === "approve" ? "approved" : "rejected";
  try {
    const result = await decidePending(platform, h, Number(req.params.pendingId!), decision, req.principal, platform.clock.now());
    return { status: result.status, body: result.body };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// ---- registry list + meta (for the UI) -------------------------------------

const getRegistries: ApiHandler = async (platform) => {
  const list = platform.allRegistries().map((h) => ({ registryId: h.def.registryId, name: h.def.name, diaryCode: h.def.diary.registryCode }));
  return { status: 200, body: { registries: list } };
};

const getMeta: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const states = (await h.db.all("SELECT id, name, is_open, is_waiting_for_customer FROM states")).map((r) => ({ id: String(r.id), name: String(r.name), isOpen: Number(r.is_open) === 1, isWaitingForCustomer: Number(r.is_waiting_for_customer) === 1 }));
  const transitions = (await h.db.all("SELECT from_state, to_state FROM state_transitions")).map((r) => ({ from: String(r.from_state), to: String(r.to_state) }));
  const forms = (await platform.shared.all("SELECT form_id, kind, audience, title, requires_approval, field_subset, property_schema, allow_attachments, operation_type FROM form_definitions WHERE registry_id = ? AND active = 1", [h.def.registryId])).map((r) => ({
    formId: String(r.form_id), kind: String(r.kind), audience: String(r.audience), title: String(r.title),
    requiresApproval: Number(r.requires_approval) === 1,
    fieldSubset: r.field_subset ? JSON.parse(String(r.field_subset)) : null,
    propertySchema: r.property_schema ? JSON.parse(String(r.property_schema)) : null,
    allowAttachments: Number(r.allow_attachments) === 1,
    operationType: r.operation_type === null ? null : String(r.operation_type),
  }));
  const categories = (await platform.shared.all("SELECT display_code, name FROM categories WHERE active = 1 ORDER BY display_code")).map((r) => ({ code: String(r.display_code), name: String(r.name) }));
  return { status: 200, body: { registryId: h.def.registryId, name: h.def.name, fields: h.def.fields, states, transitions, forms, categories } };
};

// ---- worker portal ---------------------------------------------------------

const getWorkerCases: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const workerId = req.principal.actor.workerId;
  const view = req.query.get("view") ?? "authorized";
  const cases =
    view === "assigned" ? await assignedCases(h.db, workerId)
    : view === "unassigned" ? await unassignedOptedInCases(platform.shared, h.db, workerId)
    : await authorizedCases(platform.shared, h.db, workerId);
  return { status: 200, body: { view, cases: serializeCases(cases) } };
};

const getWorkerPending: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  return { status: 200, body: { pending: await pendingToApprove(platform.shared, h.db, req.principal.actor.workerId) } };
};

const postAssign: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  const workerId = req.principal.actor.workerId;
  if (!(await workerCanAccessCategory(platform.shared, workerId, c.category, "write")))
    return { status: 403, body: { error: "forbidden" } };
  const role = String(asObject(req.body).role ?? "handler");
  const d = dialectFor(h.db.dialect);
  await h.db.run(d.insertIfAbsent("case_handlers", ["case_key", "worker_id", "role"]), [c.caseKey, workerId, role]);
  return { status: 200, body: { assigned: true, workerId, role } };
};

// Publish / unpublish a case (§5.7). A deliberate act by an authorized worker;
// recorded as an operation so the publish decision is itself auditable.
const postPublish: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  const workerId = req.principal.actor.workerId;
  if (!(await workerCanAccessCategory(platform.shared, workerId, c.category, "transition")))
    return { status: 403, body: { error: "forbidden" } };
  const publish = asObject(req.body).publish !== false;
  await h.db.transaction(async (tx) => {
    await tx.run("UPDATE cases SET is_published = ?, modified = ? WHERE case_key = ?", [publish ? 1 : 0, platform.clock.now(), c.caseKey]);
    await appendOperation(tx, { caseKey: c.caseKey, direction: "internal", type: publish ? "published" : "unpublished", actorKind: "worker", actorId: workerId }, platform.clock.now());
  });
  return { status: 200, body: { isPublished: publish } };
};

// ---- helpers ---------------------------------------------------------------

function actorStamp(p: Principal): { actorKind: "worker" | "customer" | "system"; actorId: string } {
  if (p.kind === "actor" && p.actor.kind === "worker") return { actorKind: "worker", actorId: p.actor.workerId };
  if (p.kind === "actor" && p.actor.kind === "customer") return { actorKind: "customer", actorId: p.actor.customerId };
  if (p.kind === "token") return { actorKind: "system", actorId: p.scope.tokenId };
  return { actorKind: "system", actorId: "" };
}

function serializeCases(cases: ReadonlyArray<{ caseKey: bigint; diaryNumber: string; category: string; state: string; isPublished: boolean; created: string; modified: string }>) {
  return cases.map((c) => ({ ...c, caseKey: Number(c.caseKey) }));
}

// ---- Route table -----------------------------------------------------------

const coreRoutes: readonly Route<ApiHandler>[] = [
  defineRoute("GET", "/api/registries", getRegistries),
  defineRoute("GET", "/api/registries/:registry/meta", getMeta),
  defineRoute("GET", "/api/registries/:registry/published", getPublished),
  defineRoute("GET", "/api/registries/:registry/my-cases", getMyCases),
  defineRoute("GET", "/api/registries/:registry/worker/cases", getWorkerCases),
  defineRoute("GET", "/api/registries/:registry/worker/pending", getWorkerPending),
  defineRoute("GET", "/api/registries/:registry/cases/:diary", getCase),
  defineRoute("POST", "/api/registries/:registry/cases", postCase),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/operations", postOperation),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/transition", postTransition),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/assign", postAssign),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/publish", postPublish),
  defineRoute("POST", "/api/registries/:registry/forms/:formId/submit", postFormSubmit),
  defineRoute("POST", "/api/registries/:registry/pending/:pendingId/:decision", postPendingDecision),
];

/** Core portal/API routes + the management (admin) routes. */
export const routes: readonly Route<ApiHandler>[] = [...coreRoutes, ...adminRoutes];
