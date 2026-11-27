import { createHash } from "node:crypto";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { regionalStoreFor } from "./ontologyEvents";
import type { FirestoreLike, TenantContext } from "./types";
import { isCanonicalInstant, jsonBytes } from "@/lib/ontology/events";
import { SAVED_VIEW_LIMITS, type MyView } from "@/lib/types/savedView";

/**
 * Only me views (piece C, CRM_VIEWS_ENABLED): one document per brand and team member in the brand's
 * regional `member_views`, holding that member's own saved views on People. The member is always
 * the signed in one (ctx.userId), never one a request names, so nobody reads or changes anyone
 * else's. Not part of the settings log: a view is changed in place and deleted for real. A save
 * names the rev it was made from, checked in one transaction, so two tabs can't undo each other.
 */

export const MEMBER_VIEWS = "member_views";

/** `mv_` and a hash of the brand and the member: one document each, read by id. */
export function memberViewsDocId(tenantId: string, userId: string): string {
  return `mv_${createHash("sha256").update(`${tenantId}\n${userId}`).digest("hex").slice(0, 40)}`;
}

export interface StoredMemberViews {
  views: MyView[];
  /** The rev of the last save, 0 for never. */
  rev: number;
  updatedAt: string | null;
}

const NONE: StoredMemberViews = { views: [], rev: 0, updatedAt: null };

function memberOf(ctx: TenantContext): string | null {
  return typeof ctx.userId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(ctx.userId) ? ctx.userId : null;
}

function toStored(data: Record<string, unknown>): StoredMemberViews {
  return {
    views: Array.isArray(data.views) ? (data.views as MyView[]) : [],
    rev: typeof data.rev === "number" ? data.rev : 0,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  };
}

/** The signed in member's own views on this brand: none for no member, or a document of another brand or member. */
export async function readMemberViews(ctx: TenantContext, db?: FirestoreLike): Promise<StoredMemberViews> {
  const userId = memberOf(ctx);
  if (!userId) return NONE;
  const snap = await regionalStoreFor(ctx, db).collection(MEMBER_VIEWS).doc(memberViewsDocId(ctx.tenantId, userId)).get();
  if (!snap.exists) return NONE;
  const data = snap.data() ?? {};
  if (data[TENANT_FIELD] !== ctx.tenantId || data.userId !== userId) return NONE;
  return toStored(data);
}

export type MemberViewsCommit = { ok: true; rev: number } | { ok: false; error: "views_changed"; current: StoredMemberViews };

/**
 * Save the signed in member's whole list from the rev it was made from. Answers `views_changed`
 * with the list as it is now when it moved on. Throws for no member, a list past its caps, or a
 * document that belongs to another brand.
 */
export async function commitMemberViews(
  ctx: TenantContext,
  input: { baseRev: number; views: MyView[]; nowIso?: string },
  db?: FirestoreLike,
): Promise<MemberViewsCommit> {
  const userId = memberOf(ctx);
  if (!userId) throw new TenantValidationError("Only me views need a signed in member");
  if (!Number.isInteger(input.baseRev) || input.baseRev < 0) throw new TenantValidationError("baseRev must be a whole number from 0");
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!isCanonicalInstant(nowIso)) throw new TenantValidationError("nowIso must be canonical (toISOString)");
  if (!Array.isArray(input.views) || input.views.length > SAVED_VIEW_LIMITS.mine) throw new TenantValidationError("too_many_views");
  if (jsonBytes(input.views) > SAVED_VIEW_LIMITS.mine * SAVED_VIEW_LIMITS.viewBytes) throw new TenantValidationError("views_too_large");
  const store = regionalStoreFor(ctx, db);
  const ref = store.collection(MEMBER_VIEWS).doc(memberViewsDocId(ctx.tenantId, userId));
  return store.runTransaction(async (txn): Promise<MemberViewsCommit> => {
    const snap = await txn.get(ref);
    let current = NONE;
    if (snap.exists) {
      const data = snap.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId || data.userId !== userId) throw new TenantIsolationError(`${MEMBER_VIEWS}/${ref.id} belongs to someone else`);
      current = toStored(data);
    }
    if (current.rev !== input.baseRev) return { ok: false, error: "views_changed", current };
    const rev = input.baseRev + 1;
    const doc = { [TENANT_FIELD]: ctx.tenantId, userId, rev, views: input.views, updatedAt: nowIso };
    if (snap.exists) txn.set(ref, doc);
    else txn.create(ref, doc);
    return { ok: true, rev };
  });
}
