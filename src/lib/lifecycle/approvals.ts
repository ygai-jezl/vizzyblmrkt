import { z } from "zod";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { AiDraft } from "@/lib/types/lifecycle";
import { escapeHtml } from "@/lib/email/emailRender";
import { zodReason } from "@/lib/connect/protocol";
import { AI_LINE_MARKER } from "./drafts";
import { validateAiLine, validateAiSubject } from "./insightValidator";

/**
 * The Approvals queue for AI lines: what's waiting (soonest send first), what
 * was decided, and the decisions themselves. Decisions are admin-only, name the
 * `draftVersion` they saw (409 if it moved), and close 15 minutes before the
 * send. An edited line is re-validated (422 with the reasons if it fails).
 */

export type ApiResult = { status: number; body: unknown };

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, detail?: unknown): ApiResult => ({
  status,
  body: detail === undefined ? { error } : { error, detail },
});

const DECIDABLE: ReadonlyArray<AiDraft["status"]> = ["awaiting_approval", "approved", "use_fallback", "skipped"];

export function renderPreview(d: Pick<AiDraft, "previewHtml" | "aiLine">): string | null {
  if (!d.previewHtml) return null;
  return d.previewHtml.split(AI_LINE_MARKER).join(escapeHtml(d.aiLine ?? ""));
}

async function view(ctx: TenantContext, drafts: AiDraft[], nowMs: number, db?: FirestoreLike) {
  const repo = forTenant(ctx, db);
  const journeyIds = [...new Set(drafts.map((d) => d.journeyId))];
  const userIds = [...new Set(drafts.map((d) => d.productUserId))];
  const [journeys, users] = await Promise.all([
    Promise.all(journeyIds.map((id) => repo.lifecycleJourneys.getById(id))),
    Promise.all(userIds.map((id) => repo.productUsers.getById(id))),
  ]);
  const jName = new Map(journeys.flatMap((j) => (j ? [[j.id, j.name] as const] : [])));
  const uById = new Map(users.flatMap((u) => (u ? [[u.id, u] as const] : [])));
  return drafts.map((d) => {
    const u = uById.get(d.productUserId);
    return {
      id: d.id,
      journeyId: d.journeyId,
      journeyName: jName.get(d.journeyId) ?? null,
      enrolmentId: d.enrolmentId,
      itemLabel: d.itemLabel,
      externalUserId: d.externalUserId,
      user: u ? { email: u.email ?? null, firstName: u.firstName ?? null } : null,
      status: d.status,
      requireApproval: d.requireApproval,
      sendAt: d.sendAt,
      approvalDeadline: d.approvalDeadline,
      closed: nowMs > Date.parse(d.approvalDeadline),
      insightSentence: d.insightSentence ?? null,
      aiLine: d.aiLine ?? null,
      subjectVariant: d.subjectVariant ?? null,
      standardSubject: d.standardSubject ?? null,
      factsSnapshot: d.factsSnapshot,
      allowedTerms: d.allowedTerms,
      attestedTerms: d.attestedTerms,
      validationIssues: d.validationIssues,
      fallbackReason: d.fallbackReason ?? null,
      draftVersion: d.draftVersion,
      decidedBy: d.decidedBy ?? null,
      decidedAt: d.decidedAt ?? null,
      usedVersion: d.usedVersion ?? null,
      previewHtml: renderPreview(d),
    };
  });
}

export type ApprovalView = Awaited<ReturnType<typeof view>>[number];

export async function listApprovals(
  ctx: TenantContext,
  opts: { view: "waiting" | "decided" },
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<ApiResult> {
  const repo = forTenant(ctx, db).lifecycleDrafts;
  const drafts =
    opts.view === "waiting"
      ? // Still decidable only: once the window closes the standard version goes out.
        await repo.find({
          where: [
            ["status", "==", "awaiting_approval"],
            ["approvalDeadline", ">", new Date(nowMs).toISOString()],
          ],
          orderBy: [["approvalDeadline", "asc"]],
          limit: 100,
        })
      : await repo.find({
          where: [["status", "in", ["approved", "use_fallback", "skipped", "used"]]],
          orderBy: [["updatedAt", "desc"]],
          limit: 50,
        });
  return ok({ drafts: await view(ctx, drafts, nowMs, db) });
}

/** How many AI lines are waiting for a decision (still decidable) — the sidebar badge. */
export async function countWaitingApprovals(ctx: TenantContext, db?: FirestoreLike, nowMs = Date.now()): Promise<number> {
  return forTenant(ctx, db).lifecycleDrafts.count([
    ["status", "==", "awaiting_approval"],
    ["approvalDeadline", ">", new Date(nowMs).toISOString()],
  ]);
}

const DecideInput = z.object({
  action: z.enum(["approve", "fallback", "skip"]),
  draftVersion: z.number().int().min(1),
  aiLine: z.string().max(400).optional(),
  subjectVariant: z.string().max(120).nullable().optional(),
  attestedTerms: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

export async function decideApproval(
  ctx: TenantContext,
  draftId: string,
  input: unknown,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<ApiResult> {
  const parsed = DecideInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const repo = forTenant(ctx, db).lifecycleDrafts;
  const draft = await repo.getById(draftId);
  if (!draft) return fail(404, "not_found");
  if (!DECIDABLE.includes(draft.status)) return fail(409, "not_open");
  if (nowMs > Date.parse(draft.approvalDeadline)) return fail(409, "closed");
  if (draft.draftVersion !== parsed.data.draftVersion) return fail(409, "stale");

  const now = new Date(nowMs).toISOString();
  const who = ctx.email ?? ctx.userId ?? "admin";
  let patch: Partial<Omit<AiDraft, "id" | "tenantId">>;
  const { action } = parsed.data;
  if (action === "approve") {
    if (!draft.insightId) return fail(409, "no_insight");
    const line = (parsed.data.aiLine ?? draft.aiLine ?? "").trim();
    const subject = (parsed.data.subjectVariant === undefined ? draft.subjectVariant : parsed.data.subjectVariant)?.trim() || null;
    const attested = parsed.data.attestedTerms ?? draft.attestedTerms;
    const allowed = [...draft.allowedTerms, ...attested];
    const lineCheck = validateAiLine(line, allowed);
    if (!lineCheck.ok) return fail(422, "invalid_line", lineCheck.issues);
    if (subject) {
      const subjectCheck = validateAiSubject(subject, allowed);
      if (!subjectCheck.ok) return fail(422, "invalid_subject", subjectCheck.issues);
    }
    patch = {
      status: "approved",
      aiLine: line,
      subjectVariant: subject,
      attestedTerms: attested,
      validationIssues: [],
      fallbackReason: null,
    };
  } else if (action === "fallback") {
    patch = { status: "use_fallback", fallbackReason: "staff_choice" };
  } else {
    patch = { status: "skipped", fallbackReason: null };
  }

  const done = await repo.claim(draftId, (cur) =>
    cur.draftVersion === parsed.data.draftVersion && DECIDABLE.includes(cur.status) && nowMs <= Date.parse(cur.approvalDeadline)
      ? { ...patch, decidedBy: who.slice(0, 254), decidedAt: now, draftVersion: cur.draftVersion + 1, updatedAt: now }
      : null,
  );
  if (!done) return fail(409, "stale");
  const [shown] = await view(ctx, [done], nowMs, db);
  return ok({ draft: shown });
}
