/**
 * Platform-core read queries (Architecture §5, §6).
 *
 * Domain-shaped reads the portals and REST API call. They never expose raw
 * table access; authorization is applied by the caller (handler) via
 * authorization.ts before these run, or as a filter within them.
 */

import type { Db } from "../db/db.ts";

export interface CaseView {
  caseKey: bigint;
  diaryNumber: string;
  category: string;
  state: string;
  isPublished: boolean;
  created: string;
  modified: string;
}

export interface OperationView {
  operationId: number;
  created: string;
  direction: string;
  type: string;
  subtype: string | null;
  comment: string | null;
  actorKind: string;
}

function toCaseView(row: Record<string, unknown>): CaseView {
  return {
    caseKey: BigInt(row.case_key as number),
    diaryNumber: String(row.diary_number),
    category: String(row.category),
    state: String(row.state),
    isPublished: Number(row.is_published) === 1,
    created: String(row.created),
    modified: String(row.modified),
  };
}

export async function getCaseByDiaryNumber(registryDb: Db, diaryNumber: string): Promise<CaseView | undefined> {
  const row = await registryDb.get(
    "SELECT case_key, diary_number, category, state, is_published, created, modified FROM cases WHERE diary_number = ?",
    [diaryNumber],
  );
  return row ? toCaseView(row) : undefined;
}

export async function getCaseHistory(registryDb: Db, caseKey: bigint): Promise<OperationView[]> {
  const rows = await registryDb.all(
    `SELECT operation_id, created, direction, type, subtype, comment, actor_kind
       FROM operations WHERE case_key = ? ORDER BY operation_id`,
    [caseKey],
  );
  return rows.map((r) => ({
    operationId: Number(r.operation_id),
    created: String(r.created),
    direction: String(r.direction),
    type: String(r.type),
    subtype: r.subtype === null ? null : String(r.subtype),
    comment: r.comment === null ? null : String(r.comment),
    actorKind: String(r.actor_kind),
  }));
}

/** Customer portal: this customer's cases (ownership-filtered) (§5.5, §6.2). */
export async function listCustomerCases(registryDb: Db, customerId: string): Promise<CaseView[]> {
  const rows = await registryDb.all(
    `SELECT c.case_key, c.diary_number, c.category, c.state, c.is_published, c.created, c.modified
       FROM cases c
       JOIN case_parties p ON p.case_key = c.case_key
      WHERE p.customer_id = ?
      ORDER BY c.created DESC`,
    [customerId],
  );
  return rows.map(toCaseView);
}

/** Publishing portal: only published cases (§5.7). Safe-by-default. */
export async function searchPublishedCases(registryDb: Db, categoryPrefix?: string): Promise<CaseView[]> {
  const rows = categoryPrefix
    ? await registryDb.all(
        `SELECT case_key, diary_number, category, state, is_published, created, modified
           FROM cases WHERE is_published = 1 AND category LIKE ? ORDER BY created DESC`,
        [categoryPrefix + "%"],
      )
    : await registryDb.all(
        `SELECT case_key, diary_number, category, state, is_published, created, modified
           FROM cases WHERE is_published = 1 ORDER BY created DESC`,
      );
  return rows.map(toCaseView);
}
