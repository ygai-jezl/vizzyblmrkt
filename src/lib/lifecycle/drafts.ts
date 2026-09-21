import { createHash } from "node:crypto";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { AiDraft, LifecycleEnrolment, LifecycleVersion, PoolItem } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductContext } from "@/lib/connect/protocol";
import { capitalisedNames } from "./insightValidator";

/**
 * AI-line drafts: one per (enrolment, upcoming ai_line email). The runner
 * schedules one when it books the slot that will send such an email; the tick
 * prepares it ~12 h ahead (prepare.ts); staff review it (approvals.ts); the send
 * consumes it (decide.ts).
 */

export const PREPARE_LEAD_MS = 12 * 3600_000;
export const APPROVAL_CLOSE_MS = 15 * 60_000;
export const DRAFT_TTL_MS = 90 * 86_400_000;
/** Stands in for the AI line in a stored preview, so an edit re-renders cheaply. */
export const AI_LINE_MARKER = "\u2063AI_LINE\u2063";

export function draftDocId(enrolmentId: string, poolId: string, itemId: string): string {
  return `lcd_${createHash("sha256").update(`${enrolmentId}\n${poolId}\n${itemId}`).digest("hex").slice(0, 40)}`;
}

/** Drafts still in play (not consumed, not replaced). */
export const OPEN_STATUSES: ReadonlyArray<AiDraft["status"]> = ["pending", "awaiting_approval", "approved", "use_fallback", "skipped"];

/**
 * Book a draft for the email this person is predicted to get at `sendAtMs`.
 * Idempotent: a re-booking only moves the times while it's still pending.
 */
export async function scheduleDraft(
  ctx: TenantContext,
  a: {
    enrolment: LifecycleEnrolment;
    version: Pick<LifecycleVersion, "id">;
    nodeId: string;
    poolId: string;
    item: Pick<PoolItem, "id" | "label" | "subject" | "personalization">;
    sendAtMs: number;
  },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<"scheduled" | "updated" | "unchanged" | "not_ai"> {
  if (a.item.personalization !== "ai_line") return "not_ai";
  const nowMs = deps.nowMs ?? Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const sendAt = iso(a.sendAtMs);
  const prepareAt = iso(Math.max(nowMs, a.sendAtMs - PREPARE_LEAD_MS));
  const approvalDeadline = iso(Math.max(nowMs, a.sendAtMs - APPROVAL_CLOSE_MS));
  const e = a.enrolment;
  let moved = false;
  const { created } = await forTenant(ctx, deps.db).lifecycleDrafts.upsert(
    draftDocId(e.id, a.poolId, a.item.id),
    () => ({
      enrolmentId: e.id,
      journeyId: e.journeyId,
      versionId: a.version.id,
      connectionId: e.connectionId,
      productUserId: e.productUserId,
      externalUserId: e.externalUserId,
      nodeId: a.nodeId,
      poolId: a.poolId,
      itemId: a.item.id,
      itemLabel: a.item.label.slice(0, 120),
      status: "pending",
      requireApproval: e.requireApproval,
      sendAt,
      prepareAt,
      approvalDeadline,
      prepareLeaseUntil: null,
      insightId: null,
      insightSentence: null,
      aiLine: null,
      subjectVariant: null,
      standardSubject: a.item.subject.slice(0, 200),
      factsSnapshot: [],
      allowedTerms: [],
      attestedTerms: [],
      validationIssues: [],
      previewHtml: null,
      fallbackReason: null,
      draftVersion: 1,
      decidedBy: null,
      decidedAt: null,
      usedAt: null,
      usedVersion: null,
      ttlAt: new Date(a.sendAtMs + DRAFT_TTL_MS),
      createdAt: iso(nowMs),
      updatedAt: iso(nowMs),
    }),
    (cur) => {
      if (cur.status !== "pending" || cur.sendAt === sendAt) return null;
      moved = true;
      return { sendAt, prepareAt, approvalDeadline, nodeId: a.nodeId, updatedAt: iso(nowMs) };
    },
  );
  if (created) return "scheduled";
  return moved ? "updated" : "unchanged";
}

/**
 * The names an AI line may use: the product, the sender's brand, the glossary,
 * the facts' labels and displays, and any names in the product's own insight.
 */
export function allowedTermsFor(a: {
  connection: Pick<ProductConnection, "name" | "catalog">;
  brand: string | null;
  context: ProductContext | null;
  insightSentence: string | null;
}): string[] {
  const terms = new Set<string>();
  const add = (t: string | null | undefined) => {
    const v = t?.trim();
    if (v) terms.add(v.slice(0, 200));
  };
  add(a.connection.name);
  add(a.brand);
  for (const g of a.connection.catalog.glossary) add(g.term);
  for (const s of a.connection.catalog.onboardingSteps) add(s.label);
  for (const f of a.context?.facts ?? []) {
    add(f.label);
    if (typeof f.display === "string") add(f.display);
    if (typeof f.value === "string") add(f.value);
  }
  if (a.insightSentence) for (const n of capitalisedNames(a.insightSentence)) add(n);
  return [...terms].slice(0, 200);
}

/** Retire this person's other open drafts (they took a different path, or left). */
export async function supersedeDrafts(
  ctx: TenantContext,
  enrolmentId: string,
  opts: { keepId?: string; db?: FirestoreLike; nowMs?: number } = {},
): Promise<number> {
  const repo = forTenant(ctx, opts.db).lifecycleDrafts;
  const open = (await repo.find({ where: [["enrolmentId", "==", enrolmentId]], limit: 30 })).filter(
    (d) => d.id !== opts.keepId && OPEN_STATUSES.includes(d.status),
  );
  const now = new Date(opts.nowMs ?? Date.now()).toISOString();
  let n = 0;
  for (const d of open) {
    const done = await repo.claim(d.id, (cur) =>
      OPEN_STATUSES.includes(cur.status)
        ? { status: "superseded", fallbackReason: "superseded", draftVersion: cur.draftVersion + 1, updatedAt: now }
        : null,
    );
    if (done) n += 1;
  }
  return n;
}
