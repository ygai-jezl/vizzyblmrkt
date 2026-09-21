import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { AiDraft, FallbackReason } from "@/lib/types/lifecycle";
import type { ProductContext } from "@/lib/connect/protocol";
import { fetchProductContext } from "@/lib/connect/contextClient";
import { generateTextWithDeadline, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { brandVoiceSection, fencedContext } from "@/lib/agents/prompts/compose";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { resolveFooterBrand } from "@/lib/email/sender";
import { decideNext } from "./planner";
import { renderLifecycleEmail } from "./render";
import { buildRecipientContext, buildRenderValues, nextStepOf, pickInsight, safeChecklist } from "./recipientContext";
import { recipientClock, walkEnvFor, walkStateOf } from "./walk";
import { AI_LINE_MARKER, allowedTermsFor, draftDocId, scheduleDraft } from "./drafts";
import { validateAiLine, validateAiSubject } from "./insightValidator";
import { lifecycleSender } from "./policy";
import { COUNTER_TTL_MS, utcDayKey } from "./enrol";

/**
 * Prepare AI-line drafts that are due (≈12 h before their send): re-predict the
 * email with fresh context, pick the insight, write ONE line with Gemini
 * (20 s, one attempt, no personal data in the prompt), validate it and put it in
 * the Approvals queue. Anything that fails lands on the standard version with a
 * reason — the send never waits on the model.
 */

export const GENERATION_TIMEOUT_MS = 20_000;
/** Beta cap per tenant per UTC day (until billing exists). */
export const AI_DRAFTS_PER_DAY = 100;
const PREPARE_LEASE_MS = 3 * 60_000;

export interface PrepareDeps {
  db?: FirestoreLike;
  now?: () => number;
  generate?: (prompt: string, opts: { timeoutMs: number; json?: boolean }) => Promise<string | null>;
  fetchContext?: typeof fetchProductContext;
  deadlineAt?: number;
  limit?: number;
  draftsPerDay?: number;
}

export type PrepareOutcome = "prepared" | "fallback" | "superseded" | "busy";

export interface PrepareResult {
  prepared: number;
  fallback: number;
  superseded: number;
}

export async function prepareDueDrafts(ctx: TenantContext, deps: PrepareDeps = {}): Promise<PrepareResult> {
  const clock = deps.now ?? Date.now;
  const due = await forTenant(ctx, deps.db).lifecycleDrafts.find({
    where: [
      ["status", "==", "pending"],
      ["prepareAt", "<=", new Date(clock()).toISOString()],
    ],
    orderBy: [["prepareAt", "asc"]],
    limit: deps.limit ?? 10,
  });
  const out: PrepareResult = { prepared: 0, fallback: 0, superseded: 0 };
  for (const d of due) {
    if (deps.deadlineAt !== undefined && clock() >= deps.deadlineAt) break;
    const o = await prepareDraft(ctx, d.id, deps).catch((err) => {
      console.error(`[lifecycle] prepare ${ctx.tenantId}/${d.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      return "busy" as const;
    });
    if (o === "prepared") out.prepared += 1;
    else if (o === "fallback") out.fallback += 1;
    else if (o === "superseded") out.superseded += 1;
  }
  return out;
}

export function aiDraftCounterId(tenantId: string, ms: number): string {
  return `aidrafts_${tenantId}_${utcDayKey(ms)}`;
}

function factLine(f: ProductContext["facts"][number]): string {
  const shown = f.display ?? `${f.value}${f.unit ?? ""}`;
  return `- ${f.label}: ${shown}`;
}

export async function prepareDraft(ctx: TenantContext, draftId: string, deps: PrepareDeps = {}): Promise<PrepareOutcome> {
  const clock = deps.now ?? Date.now;
  const nowMs = clock();
  const iso = (ms: number) => new Date(ms).toISOString();
  const repo = forTenant(ctx, deps.db);

  const leased = await repo.lifecycleDrafts.claim(draftId, (cur) =>
    cur.status === "pending" && !(cur.prepareLeaseUntil && cur.prepareLeaseUntil > iso(nowMs))
      ? { prepareLeaseUntil: iso(nowMs + PREPARE_LEASE_MS) }
      : null,
  );
  if (!leased) return "busy";

  const finish = async (patch: Partial<Omit<AiDraft, "id" | "tenantId">>): Promise<void> => {
    await repo.lifecycleDrafts.claim(draftId, (cur) =>
      cur.status === "pending"
        ? { ...patch, prepareLeaseUntil: null, draftVersion: cur.draftVersion + 1, updatedAt: iso(clock()) }
        : null,
    );
  };
  const supersede = async (): Promise<PrepareOutcome> => {
    await finish({ status: "superseded", fallbackReason: "superseded" });
    return "superseded";
  };
  const fallBack = async (reason: FallbackReason, extra: Partial<Omit<AiDraft, "id" | "tenantId">> = {}): Promise<PrepareOutcome> => {
    await finish({ status: "use_fallback", fallbackReason: reason, ...extra });
    return "fallback";
  };

  const enrolment = await repo.lifecycleEnrolments.getById(leased.enrolmentId);
  if (!enrolment || enrolment.status !== "active") return supersede();
  const [version, journey, connection, user, tenant] = await Promise.all([
    repo.lifecycleVersions.getById(leased.versionId),
    repo.lifecycleJourneys.getById(leased.journeyId),
    repo.productConnections.getById(leased.connectionId),
    repo.productUsers.getById(leased.productUserId),
    getTenantById(ctx.tenantId, deps.db).catch(() => null),
  ]);
  if (!version || !journey || !connection || connection.status === "revoked" || !user || user.status !== "active") {
    return supersede();
  }

  const res = await (deps.fetchContext ?? fetchProductContext)(
    connection,
    { userId: user.externalUserId, purpose: "prepare", journeyId: journey.id, nodeId: leased.nodeId },
    { db: deps.db, nowMs },
  );
  const context = res.ok ? res.context : null;
  if (context?.exit) return supersede();

  // Re-predict with fresh context: is this still the email they'll get?
  const sendAtMs = Date.parse(leased.sendAt);
  const { tz, offsetMin } = recipientClock(user, connection, version);
  const state = walkStateOf(enrolment, sendAtMs);
  const walk = decideNext(
    state,
    walkEnvFor({
      version,
      user,
      connection,
      context,
      tz,
      offsetMin,
      anchorMs: state.anchorMs,
      emailsSent: () => state.sent.filter((s) => s.status !== "skipped").length,
    }),
  );
  const d = walk.decision;
  if (d.kind !== "send" || d.pool.id !== leased.poolId || d.item.id !== leased.itemId) {
    if (d.kind === "send" && d.item.personalization === "ai_line" && draftDocId(enrolment.id, d.pool.id, d.item.id) !== draftId) {
      await scheduleDraft(ctx, { enrolment, version, nodeId: d.nodeId, poolId: d.pool.id, item: d.item, sendAtMs }, { db: deps.db, nowMs });
    }
    return supersede();
  }

  if (!context) return fallBack("no_insight");
  const rc = buildRecipientContext({
    user,
    connection,
    context,
    emailsSent: state.sent.filter((x) => x.status !== "skipped").length,
    enrolledAtMs: state.anchorMs,
    nowMs: sendAtMs,
  });
  const steps = safeChecklist(rc, connection.linkDomains);
  const next = nextStepOf(context, steps, connection.linkDomains);
  const insight = pickInsight(context, enrolment.usedInsightIds, next?.id ?? null);
  if (!insight) return fallBack("no_insight");

  // Per-tenant daily cap on model calls. (Counter ids are unique across every
  // tenant in a region, so the tenant id is part of it.)
  const cap = deps.draftsPerDay ?? AI_DRAFTS_PER_DAY;
  let overCap = cap <= 0;
  if (!overCap) {
    await repo.lifecycleCounters.upsert(
      aiDraftCounterId(ctx.tenantId, nowMs),
      () => ({ journeyId: "_ai_drafts", day: utcDayKey(nowMs), sends: 1, enrolments: 0, ttlAt: new Date(nowMs + COUNTER_TTL_MS) }),
      (cur) => {
        if (cur.sends >= cap) {
          overCap = true;
          return null;
        }
        return { sends: cur.sends + 1 };
      },
    );
  }
  if (overCap) return fallBack("draft_cap");

  const sender = lifecycleSender(tenant, version.settings.sender);
  const brand = sender.fromName || resolveFooterBrand(tenant, null);
  const facts = insight.factIds.length
    ? context.facts.filter((f) => insight.factIds.includes(f.id))
    : context.facts.slice(0, 10);
  const glossary = connection.catalog.glossary.map((g) => `- ${g.term}: ${g.definition}`).join("\n");
  const prompt = renderPrompt("lifecycle.insight_line", {
    product_name: connection.name,
    insight: insight.sentence,
    facts: facts.map(factLine).join("\n") || "(none)",
    email_purpose: `${leased.itemLabel} — "${leased.standardSubject ?? ""}"`,
    next_step: next ? fencedContext("Their next onboarding step", "next_step", next.label) : "",
    glossary: fencedContext("Product glossary (terms you may use)", "glossary", glossary),
    brand_voice: brandVoiceSection(resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice })),
  });

  const raw = await (deps.generate ?? generateTextWithDeadline)(prompt, { timeoutMs: GENERATION_TIMEOUT_MS, json: true });
  const parsed = raw ? (parseFirstJson(raw) as { line?: unknown; subject?: unknown } | null) : null;
  const line = typeof parsed?.line === "string" ? parsed.line.trim().slice(0, 400) : "";
  const subject = typeof parsed?.subject === "string" ? parsed.subject.trim().slice(0, 120) : "";
  if (!line) return fallBack("generation_failed", { insightId: insight.id, insightSentence: insight.sentence });

  const allowed = allowedTermsFor({ connection, brand, context, insightSentence: insight.sentence });
  const snapshot = facts.slice(0, 20).map((f) => ({
    id: f.id.slice(0, 64),
    label: f.label.slice(0, 120),
    display: String(f.display ?? `${f.value}${f.unit ?? ""}`).slice(0, 200),
  }));
  const lineCheck = validateAiLine(line, allowed);
  const base = {
    insightId: insight.id,
    insightSentence: insight.sentence,
    aiLine: line,
    factsSnapshot: snapshot,
    allowedTerms: allowed,
  };
  if (!lineCheck.ok) return fallBack("validation_failed", { ...base, validationIssues: lineCheck.issues.slice(0, 20) });
  const subjectVariant = subject && validateAiSubject(subject, allowed).ok ? subject : null;

  // A preview of exactly this person's email, with the line as a placeholder so
  // a staff edit re-renders without another model call. Links are inert here.
  const item = version.pools.find((p) => p.id === leased.poolId)?.items.find((i) => i.id === leased.itemId);
  let previewHtml: string | null = null;
  if (item) {
    const rendered = renderLifecycleEmail({
      item: { ...item, subject: subjectVariant ?? item.subject },
      values: buildRenderValues({
        user,
        connection,
        rc,
        context,
        insight,
        aiLine: AI_LINE_MARKER,
        footer: {
          brand,
          unsubscribeUrl: "#",
          managePreferencesUrl: "#",
          privacyUrl: "#",
          postalAddress: tenant?.emailSenderConfig?.postalAddress ?? null,
        },
      }),
    });
    previewHtml = rendered.html;
  }

  await finish({ ...base, status: "awaiting_approval", subjectVariant, validationIssues: [], previewHtml });
  return "prepared";
}
