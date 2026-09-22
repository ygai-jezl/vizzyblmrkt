import { randomUUID } from "node:crypto";
import { claimLifecycleSend, forTenant, getTenantById, listAllTenants, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type {
  DeliveryMode,
  LifecycleEnrolment,
  LifecycleJourney,
  LifecycleSettings,
  LifecycleVersion,
  SendPolicy,
  SentItem,
} from "@/lib/types/lifecycle";
import { fetchProductContext, recordContextHealth, type ContextResult } from "@/lib/connect/contextClient";
import { sendConnectionWebhook } from "@/lib/connect/webhookClient";
import { effectiveBasis } from "@/lib/connect/profile";
import type { ProductContext } from "@/lib/connect/protocol";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/email";
import { isSuppressedFor } from "@/lib/email/suppression";
import { lifecycleUnsubscribeLinks, resolvePrivacyUrl } from "@/lib/email/footer";
import { recordEmailEvent } from "@/lib/email/events";
import { resolveFooterBrand } from "@/lib/email/sender";
import type { AiDraft } from "@/lib/types/lifecycle";
import { afterSend, afterSkip, decideNext, type Decision, type WalkResult, type WalkState } from "./planner";
import { nextNodeId } from "./graph";
import { nextWindowAt } from "./sendWindow";
import { renderLifecycleEmail, type RenderedEmail } from "./render";
import { buildRecipientContext, buildRenderValues, nextStepOf, pickInsight, safeChecklist } from "./recipientContext";
import { isTestRecipient, lifecycleSender, lowestMode } from "./policy";
import { isLifecycleAiDraftsEnabled, lifecycleModeCeiling } from "./flags";
import { COUNTER_TTL_MS, counterDocId, utcDayKey } from "./enrol";
import { drainConnectionWebhooks, type WebhookDrainResult } from "./webhooksOut";
import { recipientClock, walkEnvFor, walkStateOf } from "./walk";
import { draftDocId, scheduleDraft, supersedeDrafts } from "./drafts";
import { decideSendVersion, type SendVersion } from "./decide";
import { prepareDraft, prepareDueDrafts, type PrepareDeps, type PrepareResult } from "./prepare";

/**
 * The lifecycle RUNNER. Each due enrolment is one queue item, processed by the
 * 2-minute tick (Cloud Scheduler → /api/admin/lifecycle/tick):
 *
 *   lease → gates (journey / connection / user / hard stop / opt-outs)
 *         → walk the graph (planner.decideNext) with the product's live context
 *         → email: consent → recipient for the delivery mode → frequency cap
 *                  → render → claim (daily cap + pendingSend, atomically)
 *                  → send → commit
 *
 * Exactly-once-or-never: a send is claimed (`pendingSend`) before the provider
 * call. If the process dies before the commit, the next run records it as
 * `unknown` and moves on — it is never resent. Ambiguous provider answers are
 * treated the same way. At most one email per enrolment per run.
 */

const DAY_MS = 86_400_000;
const LEASE_MS = 3 * 60_000;
export const LIFECYCLE_RUN_BUDGET_MS = 80_000;
const CONCURRENCY = 4;
const DUE_LIMIT = 50;
/** Re-check a blocked enrolment (paused journey, mode ceiling…) this often. */
const HOLD_MS = 30 * 60_000;
const PRODUCT_HOLD_DEFAULT_MS = 6 * 3600_000;
const PRODUCT_HOLD_MAX_MS = DAY_MS;
/** Minimum gap between two lifecycle emails to one user, across journeys. */
const FREQUENCY_GAP_MS = 20 * 3600_000;
const MAX_FAILURES = 8;
const MAX_LOG = 40;

type EnrolmentDoc = Omit<LifecycleEnrolment, "id" | "tenantId">;
type LogEntry = LifecycleEnrolment["log"][number];

export interface RunnerDeps {
  db?: FirestoreLike;
  now?: () => number;
  send?: (msg: EmailMessage) => Promise<EmailResult>;
  fetchContext?: typeof fetchProductContext;
  sendWebhook?: typeof sendConnectionWebhook;
  listTenants?: () => Promise<Tenant[]>;
  budgetMs?: number;
  /** AI line writer for draft preparation (tests inject a stub). */
  generate?: PrepareDeps["generate"];
}

export type EnrolmentRunOutcome =
  | "not_due"
  | "waiting"
  | "held"
  | "sent"
  | "completed"
  | "exited"
  | "failed"
  | "lost_lease";

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
const cursorOf = (nodeId: string | null) => (nodeId ? { nodeId } : null);

function withLog(log: LogEntry[], entries: LogEntry[]): LogEntry[] {
  const out = [...log];
  for (const e of entries) {
    const last = out[out.length - 1];
    // A repeated hold (paused journey, waiting for consent…) is logged once.
    if (last && last.event === e.event && (last.detail ?? null) === (e.detail ?? null)) continue;
    out.push(e);
  }
  return out.slice(-MAX_LOG);
}

function backoffMs(failures: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3600_000);
}

function nextUtcMidnight(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
}

/** Per-tick memo of the documents many enrolments share. */
export class RunCache {
  private tenantP?: Promise<Tenant | null>;
  private readonly journeys = new Map<string, Promise<LifecycleJourney | null>>();
  private readonly versions = new Map<string, Promise<LifecycleVersion | null>>();
  private readonly connections = new Map<string, Promise<ProductConnection | null>>();
  readonly healthNoted = new Set<string>();

  constructor(
    private readonly ctx: TenantContext,
    private readonly db?: FirestoreLike,
  ) {}

  private memo<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) {
      p = load();
      map.set(key, p);
    }
    return p;
  }

  tenant(): Promise<Tenant | null> {
    this.tenantP ??= getTenantById(this.ctx.tenantId, this.db).catch(() => null);
    return this.tenantP;
  }
  journey(id: string) {
    return this.memo(this.journeys, id, () => forTenant(this.ctx, this.db).lifecycleJourneys.getById(id));
  }
  version(id: string) {
    return this.memo(this.versions, id, () => forTenant(this.ctx, this.db).lifecycleVersions.getById(id));
  }
  connection(id: string) {
    return this.memo(this.connections, id, () => forTenant(this.ctx, this.db).productConnections.getById(id));
  }
}

type DeliverResult =
  | {
      kind: "sent";
      status: "sent" | "unknown";
      reason: string | null;
      insightId: string | null;
      atMs: number;
      version?: "standard" | "ai" | "fallback";
    }
  | { kind: "skipped"; reason: string }
  | { kind: "hold"; untilMs: number; event: string; detail?: string }
  | { kind: "exclude"; reason: string }
  | { kind: "exit"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "lost_lease" };

interface RunScope {
  ctx: TenantContext;
  deps: RunnerDeps;
  cache: RunCache;
  enrolment: LifecycleEnrolment;
  leaseId: string;
  journey: LifecycleJourney;
  version: LifecycleVersion;
  connection: ProductConnection;
  user: ProductUser;
  mode: DeliveryMode;
  tz: string;
  offsetMin: number;
  policy: SendPolicy;
  settings: LifecycleSettings;
  nowMs: number;
}

/**
 * Process ONE enrolment if it's due and not leased elsewhere. Safe to call from
 * overlapping ticks: the lease makes it single-flight.
 */
export async function processEnrolment(
  ctx: TenantContext,
  enrolmentId: string,
  deps: RunnerDeps = {},
  opts: { cache?: RunCache; seed?: LifecycleEnrolment } = {},
): Promise<EnrolmentRunOutcome> {
  const clock = deps.now ?? Date.now;
  const cache = opts.cache ?? new RunCache(ctx, deps.db);
  const repo = forTenant(ctx, deps.db);
  const nowMs = clock();
  const nowIso = iso(nowMs);

  const seed = opts.seed ?? (await repo.lifecycleEnrolments.getById(enrolmentId));
  if (!seed || seed.status !== "active") return "not_due";
  // Versions are immutable, so it's safe to load before the lease.
  const version = await cache.version(seed.versionId);

  const leaseId = randomUUID();
  const leased = await repo.lifecycleEnrolments.claim(enrolmentId, (cur) => {
    if (cur.status !== "active" || !cur.nextRunAt || cur.nextRunAt > nowIso) return null;
    if (cur.leaseUntil && cur.leaseUntil > nowIso) return null;
    const patch: Partial<EnrolmentDoc> = { leaseId, leaseUntil: iso(nowMs + LEASE_MS) };
    // A send that started but never finished: its outcome is unknown, so it is
    // recorded as such and NEVER resent.
    const p = cur.pendingSend;
    if (p) {
      patch.sentItems = [
        ...cur.sentItems,
        { nodeId: p.nodeId, poolId: p.poolId, itemId: p.itemId, at: p.at, status: "unknown" as const, mode: cur.mode, reason: "interrupted" },
      ].slice(-60);
      patch.pendingSend = null;
      patch.lastSentAt = p.at;
      patch.windowExemptUntil = null;
      if (version) patch.cursor = cursorOf(nextNodeId(version.graph, p.nodeId));
      patch.log = withLog(cur.log, [{ at: nowIso, event: "send_unknown", detail: `${p.poolId}/${p.itemId}: interrupted` }]);
    }
    return patch;
  });
  if (!leased) return "not_due";

  const pendingLog: LogEntry[] = [];
  const log = (event: string, detail?: string | null) =>
    pendingLog.push({ at: nowIso, event: event.slice(0, 80), detail: detail ? detail.slice(0, 300) : null });

  /** Write the run's outcome and release the lease (only if we still hold it). */
  const commit = async (patch: Partial<EnrolmentDoc>): Promise<boolean> => {
    const done = await repo.lifecycleEnrolments.claim(enrolmentId, (cur) => {
      if (cur.leaseId !== leaseId) return null;
      return { ...patch, log: withLog(cur.log, pendingLog), leaseId: null, leaseUntil: null, updatedAt: iso(clock()) };
    });
    return done !== null;
  };
  const retireDrafts = () =>
    supersedeDrafts(ctx, enrolmentId, { db: deps.db, nowMs }).catch((err) => {
      console.warn(`[lifecycle] supersede drafts ${ctx.tenantId}/${enrolmentId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      return 0;
    });
  const stop = async (reason: string, status: "exited" | "completed" = "exited"): Promise<EnrolmentRunOutcome> => {
    log(status === "completed" ? "completed" : "stopped", status === "completed" ? null : reason);
    const ok = await commit({
      status,
      stopReason: status === "completed" ? null : reason.slice(0, 120),
      cursor: null,
      nextRunAt: null,
      pendingSend: null,
    });
    if (ok) await retireDrafts();
    return ok ? status : "lost_lease";
  };
  const hold = async (untilMs: number, event: string, detail?: string): Promise<EnrolmentRunOutcome> => {
    log(event, detail);
    return (await commit({ nextRunAt: iso(untilMs), failures: 0 })) ? "held" : "lost_lease";
  };

  try {
    if (!version) return await stop("version_missing");
    const journey = await cache.journey(leased.journeyId);
    if (!journey || journey.status === "archived") return await stop("journey_archived");
    if (journey.status !== "active") return await hold(nowMs + HOLD_MS, "journey_paused");
    const connection = await cache.connection(leased.connectionId);
    if (!connection || connection.status === "revoked") return await stop("connection_revoked");
    if (connection.status !== "active") return await hold(nowMs + HOLD_MS, "connection_paused");
    const user = await repo.productUsers.getById(leased.productUserId);
    if (!user || user.status !== "active") return await stop("user_deleted");

    const settings = version.settings;
    const policy = settings.sendPolicy;
    const anchorMs = Date.parse(leased.anchorAt);
    if (nowMs > anchorMs + policy.hardStopDays * DAY_MS) return await stop("hard_stop");
    if (user.emailPreferences[settings.category.key]?.subscribed === false) return await stop("unsubscribed_in_product");
    if (user.email && (await isSuppressedFor(ctx, user.email, settings.category.key, deps.db))) {
      return await stop("unsubscribed");
    }

    const scope: RunScope = {
      ctx,
      deps,
      cache,
      enrolment: leased,
      leaseId,
      journey,
      version,
      connection,
      user,
      mode: lowestMode(leased.mode, journey.deliveryMode, lifecycleModeCeiling()),
      ...recipientClock(user, connection, version),
      policy,
      settings,
      nowMs,
    };

    const startCursor = leased.cursor?.nodeId ?? null;
    let state: WalkState = walkStateOf(leased, nowMs);
    const excluded = new Set<string>();
    let context: ProductContext | null = null;
    const env = (c: ProductContext | null, probe?: { used: boolean }) =>
      walkEnvFor({
        version,
        user,
        connection,
        context: c,
        tz: scope.tz,
        offsetMin: scope.offsetMin,
        anchorMs,
        emailsSent: () => state.sent.filter((s) => s.status !== "skipped").length,
        excluded,
        probe,
      });

    // Walk once without context: a run that only reaches a wait needs no call
    // to the product. Anything that reads the user's state (a condition, a pool
    // pick, a send) gets ONE live context pull, then the walk is redone with it.
    const probe = { used: false };
    let walk: WalkResult = decideNext(state, env(null, probe));
    if (probe.used || walk.decision.kind === "send") {
      const res = await (deps.fetchContext ?? fetchProductContext)(
        connection,
        { userId: user.externalUserId, purpose: "send", journeyId: journey.id, nodeId: startCursor },
        { db: deps.db, nowMs },
      );
      await noteContextHealth(scope, res);
      if (res.ok) {
        context = res.context;
        if (context.exit) return await stop(`product_exit: ${context.exit.reason}`);
        if (context.hold) {
          const asked = context.hold.until ? Date.parse(context.hold.until) : nowMs + PRODUCT_HOLD_DEFAULT_MS;
          const until = Math.min(Math.max(asked, nowMs + 60_000), nowMs + PRODUCT_HOLD_MAX_MS);
          return await hold(until, "product_hold", context.hold.reason);
        }
      } else {
        log("context_unavailable", res.error);
      }
      walk = decideNext(state, env(context));
    }

    const sentItems: SentItem[] = [...leased.sentItems];
    const usedInsightIds = [...leased.usedInsightIds];
    let lastSentAt = leased.lastSentAt ?? null;
    let sentOne = false;
    const progress = () => ({
      sentItems: sentItems.slice(-60),
      usedInsightIds: usedInsightIds.slice(-60),
      lastSentAt,
      pendingSend: null,
      failures: 0,
    });

    for (let guard = 0; guard < 12; guard += 1) {
      for (const s of walk.skipped) log("nothing_to_send", `${s.nodeId} (${s.poolId})`);
      const d: Decision = walk.decision;
      state = walk.state;

      if (d.kind === "run_at") {
        const ok = await commit({
          ...progress(),
          cursor: cursorOf(state.cursor),
          nextRunAt: iso(d.runAtMs),
          windowExemptUntil: isoOrNull(state.windowExemptUntilMs),
        });
        if (ok && d.reason === "wait" && isLifecycleAiDraftsEnabled()) {
          // Predict the email this booked slot will send; if it carries an AI
          // line, book a draft so it can be written and reviewed ahead of time.
          const ahead = decideNext({ ...state, nowMs: d.runAtMs }, env(context)).decision;
          if (ahead.kind === "send") {
            await scheduleDraft(
              ctx,
              { enrolment: leased, version, nodeId: ahead.nodeId, poolId: ahead.pool.id, item: ahead.item, sendAtMs: d.runAtMs },
              { db: deps.db, nowMs },
            ).catch((err) => {
              console.warn(`[lifecycle] draft booking ${ctx.tenantId}/${enrolmentId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            });
          }
        }
        return ok ? (sentOne ? "sent" : "waiting") : "lost_lease";
      }
      if (d.kind === "complete" || d.kind === "exit") {
        log(d.kind === "complete" ? "completed" : "stopped", d.kind === "exit" ? d.reason : null);
        const ok = await commit({
          ...progress(),
          status: d.kind === "complete" ? "completed" : "exited",
          stopReason: d.kind === "exit" ? d.reason : null,
          cursor: null,
          nextRunAt: null,
        });
        if (ok) await retireDrafts();
        return ok ? (sentOne ? "sent" : d.kind === "complete" ? "completed" : "exited") : "lost_lease";
      }

      // An email is due.
      if (sentOne) {
        // One email per run; the next one goes on the next tick.
        const ok = await commit({
          ...progress(),
          cursor: cursorOf(state.cursor),
          nextRunAt: iso(clock() + 60_000),
          windowExemptUntil: isoOrNull(state.windowExemptUntilMs),
        });
        return ok ? "sent" : "lost_lease";
      }
      const r = await deliver(scope, d, context, usedInsightIds, state);
      switch (r.kind) {
        case "lost_lease":
          return "lost_lease";
        case "exit":
          return await stop(r.reason);
        case "hold":
          // Resume from where this run started, so conditions are re-checked
          // against fresh context next time.
          return await hold(r.untilMs, r.event, r.detail);
        case "exclude":
          excluded.add(`${d.pool.id}:${d.item.id}`);
          log("item_skipped", `${d.item.id}: ${r.reason}`);
          walk = decideNext(state, env(context));
          continue;
        case "failed": {
          log("send_failed", r.reason);
          const failures = leased.failures + 1;
          if (failures >= MAX_FAILURES) return await stop("send_failed");
          const ok = await commit({ pendingSend: null, failures, nextRunAt: iso(nowMs + backoffMs(failures)) });
          return ok ? "failed" : "lost_lease";
        }
        case "skipped":
          sentItems.push({
            nodeId: d.nodeId,
            poolId: d.pool.id,
            itemId: d.item.id,
            at: iso(clock()),
            status: "skipped",
            mode: scope.mode,
            reason: r.reason,
          });
          log("email_skipped", `${d.item.label}: ${r.reason.replace(/_/g, " ")}`);
          state = afterSkip(state, d);
          walk = decideNext(state, env(context));
          continue;
        case "sent": {
          sentItems.push({
            nodeId: d.nodeId,
            poolId: d.pool.id,
            itemId: d.item.id,
            at: iso(r.atMs),
            status: r.status,
            mode: scope.mode,
            reason: r.reason,
            ...(r.version ? { version: r.version } : {}),
          });
          if (r.insightId) usedInsightIds.push(r.insightId);
          lastSentAt = iso(r.atMs);
          log(r.status === "sent" ? "sent" : "send_unknown", `${d.item.label} (${scope.mode})${r.reason ? ` · ${r.reason}` : ""}`);
          sentOne = true;
          state = afterSend(state, d, r.atMs, r.status);
          walk = decideNext(state, env(context));
          continue;
        }
      }
    }
    log("stopped", "too_many_steps");
    return (await commit({ ...progress(), status: "exited", stopReason: "too_many_steps", cursor: null, nextRunAt: null }))
      ? "exited"
      : "lost_lease";
  } catch (err) {
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.error(`[lifecycle] run failed ${ctx.tenantId}/${enrolmentId}: ${m}`);
    log("run_failed", m);
    const failures = leased.failures + 1;
    if (failures >= MAX_FAILURES) {
      return (await commit({ status: "exited", stopReason: "run_failed", cursor: null, nextRunAt: null }).catch(() => false))
        ? "exited"
        : "lost_lease";
    }
    const ok = await commit({ failures, nextRunAt: iso(nowMs + backoffMs(failures)) }).catch(() => false);
    return ok ? "failed" : "lost_lease";
  }
}

/** Record context health at most once per connection per tick. */
async function noteContextHealth(s: RunScope, res: ContextResult): Promise<void> {
  if (s.cache.healthNoted.has(s.connection.id)) return;
  s.cache.healthNoted.add(s.connection.id);
  await recordContextHealth(s.ctx, s.connection, res, s.deps.db).catch(() => {});
}

async function deliver(
  s: RunScope,
  d: Extract<Decision, { kind: "send" }>,
  context: ProductContext | null,
  usedInsightIds: string[],
  state: WalkState,
): Promise<DeliverResult> {
  const { ctx, deps, journey, connection, user, settings, mode } = s;
  const { item } = d;
  const clock = deps.now ?? Date.now;
  const holdFor = (ms: number, event: string, detail?: string): DeliverResult => ({ kind: "hold", untilMs: s.nowMs + ms, event, detail });
  const nextDayWindow = () => nextWindowAt(s.nowMs, s.tz, s.policy, s.offsetMin, { afterLocalDateOfMs: s.nowMs });

  // The product can opt the user out of this category in its own context.
  if (context?.consent?.categories?.[settings.category.key] === false) return { kind: "exit", reason: "unsubscribed_in_product" };
  // Marketing needs a basis this connection accepts; service mail doesn't.
  if (item.messageClass === "marketing") {
    const basis = context?.consent?.basis
      ? effectiveBasis(context.consent.basis, user.email, connection)
      : (user.consent?.basis ?? "none");
    if (!connection.consentPolicy.marketingBases.includes(basis)) {
      return { kind: "hold", untilMs: nextDayWindow(), event: "waiting_for_consent", detail: `basis: ${basis}` };
    }
  }
  if (!user.email) return { kind: "hold", untilMs: nextDayWindow(), event: "no_email" };

  // Who actually receives it, by delivery mode.
  let to = user.email;
  if (mode === "test" && !isTestRecipient(journey, user)) return holdFor(HOLD_MS, "mode_blocked", "test mode: not a test recipient");
  if (mode === "shadow") {
    if (!journey.shadowInbox) return holdFor(HOLD_MS, "no_shadow_inbox");
    to = journey.shadowInbox;
  }
  const tenant = await s.cache.tenant();
  const sender = lifecycleSender(tenant, settings.sender);
  if (mode === "live" && !sender.verified) return holdFor(HOLD_MS, "sender_unverified");
  const postalAddress = tenant?.emailSenderConfig?.postalAddress?.trim() || null;
  if (mode === "live" && item.messageClass === "marketing" && !postalAddress) return holdFor(HOLD_MS, "postal_address_missing");

  // At most one lifecycle email per user per FREQUENCY_GAP, across journeys.
  const others = await forTenant(ctx, deps.db).lifecycleEnrolments.find({
    where: [["productUserId", "==", user.id]],
    limit: 20,
  });
  const recent = others
    .filter((e) => e.id !== s.enrolment.id && e.lastSentAt)
    .map((e) => Date.parse(e.lastSentAt!))
    .filter((ms) => s.nowMs - ms < FREQUENCY_GAP_MS);
  if (recent.length > 0) {
    const until = nextWindowAt(Math.max(...recent) + FREQUENCY_GAP_MS, s.tz, s.policy, s.offsetMin);
    return { kind: "hold", untilMs: until, event: "frequency_cap" };
  }

  // Render. Shadow mail carries no real unsubscribe token (the operator's
  // inbox must never be able to unsubscribe the real user).
  const links =
    mode === "shadow"
      ? { pageUrl: "", apiUrl: "" }
      : lifecycleUnsubscribeLinks({
          tenantId: ctx.tenantId,
          email: user.email,
          recipientId: user.id,
          connectionId: connection.id,
          category: settings.category.key,
          categoryLabel: settings.category.label,
        });
  if (mode !== "shadow" && item.messageClass === "marketing" && !links.apiUrl) {
    return holdFor(HOLD_MS, "unsubscribe_unconfigured");
  }
  const privacyUrl = resolvePrivacyUrl(tenant);
  const rc = buildRecipientContext({
    user,
    connection,
    context,
    emailsSent: state.sent.filter((x) => x.status !== "skipped").length,
    enrolledAtMs: state.anchorMs,
    nowMs: s.nowMs,
  });
  const steps = safeChecklist(rc, connection.linkDomains);
  const footer = {
    brand: sender.fromName || resolveFooterBrand(tenant, null),
    unsubscribeUrl: links.pageUrl || privacyUrl,
    managePreferencesUrl: links.pageUrl || privacyUrl,
    privacyUrl,
    postalAddress,
  };
  const renderWith = (
    insight: ProductContext["insights"][number] | null,
    aiLine: string | null,
    subject?: string | null,
  ): RenderedEmail =>
    renderLifecycleEmail({
      item: subject ? { ...item, subject } : item,
      values: buildRenderValues({ user, connection, rc, context, insight, aiLine, footer }),
      shadowFor: mode === "shadow" ? user.email : null,
    });

  const standardInsight = pickInsight(context, usedInsightIds, nextStepOf(context, steps, connection.linkDomains)?.id ?? null);
  const standard = renderWith(standardInsight, null);
  if (standard.missing.length > 0) return { kind: "exclude", reason: `missing ${standard.missing.join(", ")}` };
  if (!standard.subject) return { kind: "exclude", reason: "empty subject" };

  // An AI-line email: render the reviewed line too (if there is one); the send
  // transaction then picks the version from the FRESHEST draft.
  const isAi = item.personalization === "ai_line";
  const aiOn = isLifecycleAiDraftsEnabled();
  const requireApproval = s.enrolment.requireApproval;
  const draftId = isAi ? draftDocId(s.enrolment.id, d.pool.id, item.id) : null;
  let aiEmail: { email: RenderedEmail; draftVersion: number } | null = null;
  if (draftId) {
    const pre = await forTenant(ctx, deps.db).lifecycleDrafts.getById(draftId);
    const preVersion = decideSendVersion({ draft: pre, requireApproval, context, aiEnabled: aiOn });
    if (pre && preVersion.version === "ai") {
      const email = renderWith(context?.insights.find((i) => i.id === preVersion.insightId) ?? null, preVersion.aiLine, preVersion.subject);
      if (email.missing.length === 0 && email.subject) aiEmail = { email, draftVersion: pre.draftVersion };
    }
  }

  // Claim: the day's send slot + pendingSend (+ the draft), in one transaction.
  const atMs = clock();
  const counterId = counterDocId(journey.id, atMs);
  const picked: { v: SendVersion | null; prevStatus: AiDraft["status"] | null } = { v: null, prevStatus: null };
  const claim = await claimLifecycleSend(
    ctx,
    {
      enrolmentId: s.enrolment.id,
      leaseId: s.leaseId,
      pendingSend: { nodeId: d.nodeId, poolId: d.pool.id, itemId: item.id, at: iso(atMs) },
      counter: { id: counterId, journeyId: journey.id, day: utcDayKey(atMs), cap: journey.caps.sendsPerDay, ttlAt: new Date(atMs + COUNTER_TTL_MS) },
      updatedAt: iso(atMs),
      ...(draftId
        ? {
            draft: {
              id: draftId,
              decide: (current: Record<string, unknown> | null) => {
                const fresh = current as AiDraft | null;
                let v = decideSendVersion({ draft: fresh, requireApproval, context, aiEnabled: aiOn });
                if (v.version === "ai" && (!aiEmail || fresh?.draftVersion !== aiEmail.draftVersion)) {
                  // Edited between our read and the send, or the AI version didn't render.
                  v = requireApproval
                    ? { version: "skip", reason: "approval_required" }
                    : { version: "fallback", reason: aiEmail ? "changed_during_send" : "render_failed" };
                }
                picked.v = v;
                picked.prevStatus = fresh?.status ?? null;
                return {
                  send: v.version !== "skip",
                  patch: fresh
                    ? {
                        status: "used",
                        usedVersion: v.version,
                        usedAt: iso(atMs),
                        fallbackReason: v.version === "fallback" ? v.reason : (fresh.fallbackReason ?? null),
                        draftVersion: fresh.draftVersion + 1,
                        updatedAt: iso(atMs),
                      }
                    : null,
                };
              },
            },
          }
        : {}),
    },
    deps.db,
  );
  if (claim === "lost_lease") return { kind: "lost_lease" };
  if (claim === "capped") {
    return { kind: "hold", untilMs: nextWindowAt(nextUtcMidnight(atMs), s.tz, s.policy, s.offsetMin), event: "daily_cap" };
  }
  const v = picked.v;
  if (claim === "declined") return { kind: "skipped", reason: v?.version === "skip" ? v.reason : "declined" };

  const useAi = v?.version === "ai" && aiEmail !== null;
  const email = useAi ? aiEmail!.email : standard;
  const version: "standard" | "ai" | "fallback" = !isAi ? "standard" : useAi ? "ai" : "fallback";
  const fallbackNote = v?.version === "fallback" ? v.reason : null;
  const insightId = v?.version === "ai" ? v.insightId : standard.insightUsed ? (standardInsight?.id ?? null) : null;

  const result = await (deps.send ?? sendEmail)({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    track: { opens: settings.tracking.opens, clicks: settings.tracking.clicks },
    // Shadow mail isn't attributed: opens in the operator's inbox aren't the user's.
    ...(mode === "shadow"
      ? { tags: ["lifecycle-shadow"] }
      : {
          tags: ["lifecycle"],
          metadata: {
            tenantId: ctx.tenantId,
            journeyId: journey.id,
            nodeId: d.nodeId,
            signupId: user.id,
            variantId: item.id,
            campaignId: "",
            recipientKind: "product_user",
            connectionId: connection.id,
          },
        }),
    ...(links.apiUrl ? { listUnsubscribe: { url: links.apiUrl, oneClick: true } } : {}),
  }).catch(
    // sendEmail doesn't throw; if it ever does, the message may have gone out.
    (err): EmailResult => ({ sent: false, provider: "mandrill", reason: err instanceof Error ? err.message.slice(0, 120) : "error", ambiguous: true }),
  );

  const note = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ") || null;
  if (result.sent || result.provider === "log") {
    if (result.sent && mode !== "shadow") {
      await recordEmailEvent(
        ctx,
        {
          campaignId: "",
          recipientKind: "product_user",
          connectionId: connection.id,
          journeyId: journey.id,
          nodeId: d.nodeId,
          signupId: user.id,
          variantId: item.id,
          type: "send",
          ts: iso(atMs),
          mandrillMessageId: result.id ?? null,
        },
        deps.db,
      ).catch(() => {});
    }
    return {
      kind: "sent",
      status: "sent",
      reason: note(fallbackNote, result.sent ? null : "log provider (not delivered)"),
      insightId,
      atMs,
      version,
    };
  }
  if (result.ambiguous) {
    return { kind: "sent", status: "unknown", reason: note(fallbackNote, result.reason ?? "ambiguous"), insightId, atMs, version };
  }

  // A definite failure: nothing went out, so give the day's slot back and put
  // the draft back as it was — the retry makes the same choice.
  await forTenant(ctx, deps.db)
    .lifecycleCounters.claim(counterId, (cur) => ({ sends: Math.max(0, cur.sends - 1) }))
    .catch(() => {});
  const prevStatus = picked.prevStatus;
  if (draftId && prevStatus) {
    await forTenant(ctx, deps.db)
      .lifecycleDrafts.claim(draftId, (cur) =>
        cur.status === "used"
          ? { status: prevStatus, usedVersion: null, usedAt: null, draftVersion: cur.draftVersion + 1, updatedAt: iso(clock()) }
          : null,
      )
      .catch(() => {});
  }
  return { kind: "failed", reason: `${result.provider}: ${result.reason ?? "failed"}` };
}

// ---- Tick ----------------------------------------------------------------------------------

export interface TenantRunResult {
  due: number;
  outcomes: Partial<Record<EnrolmentRunOutcome, number>>;
  deferred: number;
  webhooks: WebhookDrainResult;
  drafts: PrepareResult;
}

/** Drain one tenant: its due enrolments (4 at a time), outbound webhooks, then AI-line drafts to prepare. */
export async function drainLifecycleTenant(
  ctx: TenantContext,
  deps: RunnerDeps = {},
  deadlineAt?: number,
): Promise<TenantRunResult> {
  const clock = deps.now ?? Date.now;
  const deadline = deadlineAt ?? clock() + (deps.budgetMs ?? LIFECYCLE_RUN_BUDGET_MS);
  const due = await forTenant(ctx, deps.db).lifecycleEnrolments.find({
    where: [
      ["status", "==", "active"],
      ["nextRunAt", "<=", iso(clock())],
    ],
    orderBy: [["nextRunAt", "asc"]],
    limit: DUE_LIMIT,
  });
  const cache = new RunCache(ctx, deps.db);
  const outcomes: TenantRunResult["outcomes"] = {};
  let deferred = 0;
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const e = due[next++]!;
      if (clock() >= deadline) {
        deferred += 1;
        continue;
      }
      const o = await processEnrolment(ctx, e.id, deps, { cache, seed: e }).catch((err) => {
        console.error(`[lifecycle] ${ctx.tenantId}/${e.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
        return "failed" as const;
      });
      outcomes[o] = (outcomes[o] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));

  const webhooks =
    clock() < deadline
      ? await drainConnectionWebhooks(ctx, { db: deps.db, now: clock, deadlineAt: deadline, send: deps.sendWebhook }).catch(
          (err): WebhookDrainResult => {
            console.error(`[lifecycle] webhooks ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return { delivered: 0, failed: 0, expired: 0 };
          },
        )
      : { delivered: 0, failed: 0, expired: 0 };
  const drafts: PrepareResult =
    isLifecycleAiDraftsEnabled() && clock() < deadline
      ? await prepareDueDrafts(ctx, {
          db: deps.db,
          now: clock,
          deadlineAt: deadline,
          fetchContext: deps.fetchContext,
          generate: deps.generate,
        }).catch((err): PrepareResult => {
          console.error(`[lifecycle] drafts ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
          return { prepared: 0, fallback: 0, superseded: 0 };
        })
      : { prepared: 0, fallback: 0, superseded: 0 };
  return { due: due.length, outcomes, deferred, webhooks, drafts };
}

export interface LifecycleTickResult {
  tenants: number;
  deferredTenants: number;
  outcomes: Partial<Record<EnrolmentRunOutcome, number>>;
  webhooks: WebhookDrainResult;
  drafts: PrepareResult;
}

/** The scheduler's tick: every tenant, within the run budget. */
export async function runLifecycleTick(deps: RunnerDeps = {}): Promise<LifecycleTickResult> {
  const clock = deps.now ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? LIFECYCLE_RUN_BUDGET_MS);
  const tenants = await (deps.listTenants ?? listAllTenants)();
  const total: LifecycleTickResult = {
    tenants: 0,
    deferredTenants: 0,
    outcomes: {},
    webhooks: { delivered: 0, failed: 0, expired: 0 },
    drafts: { prepared: 0, fallback: 0, superseded: 0 },
  };
  for (const t of tenants) {
    if (clock() >= deadline) {
      total.deferredTenants += 1;
      continue;
    }
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const r = await drainLifecycleTenant(ctx, deps, deadline);
      total.tenants += 1;
      for (const [k, v] of Object.entries(r.outcomes)) {
        const key = k as EnrolmentRunOutcome;
        total.outcomes[key] = (total.outcomes[key] ?? 0) + (v ?? 0);
      }
      total.webhooks.delivered += r.webhooks.delivered;
      total.webhooks.failed += r.webhooks.failed;
      total.webhooks.expired += r.webhooks.expired;
      total.drafts.prepared += r.drafts.prepared;
      total.drafts.fallback += r.drafts.fallback;
      total.drafts.superseded += r.drafts.superseded;
    } catch (err) {
      console.warn(`[lifecycle] tenant ${t.id} (${t.region}) drain failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  return total;
}

/**
 * "Run next step now" (admin): skip the current wait and send window for ONE
 * enrolment, then process it — the next email goes out now. Only for enrolments that can't reach a real user
 * unexpectedly — test or shadow mode, never live.
 *
 * If the next email has a personalised draft still waiting to be prepared
 * (normally ~12 h before its send), the first press prepares it instead, so it
 * reaches the Approval Queue; the next press sends, using the approved line if
 * staff approved it and the standard version otherwise.
 */
export async function runEnrolmentNow(
  ctx: TenantContext,
  enrolmentId: string,
  deps: RunnerDeps = {},
): Promise<
  | { ok: true; outcome: EnrolmentRunOutcome | "draft_prepared" | "draft_fallback" }
  | { ok: false; error: "not_found" | "not_active" | "live" | "busy" }
> {
  const clock = deps.now ?? Date.now;
  const repo = forTenant(ctx, deps.db);
  const enrolment = await repo.lifecycleEnrolments.getById(enrolmentId);
  if (!enrolment) return { ok: false, error: "not_found" };
  if (enrolment.status !== "active") return { ok: false, error: "not_active" };
  const journey = await repo.lifecycleJourneys.getById(enrolment.journeyId);
  if (!journey) return { ok: false, error: "not_found" };
  if (lowestMode(enrolment.mode, journey.deliveryMode, lifecycleModeCeiling()) === "live") return { ok: false, error: "live" };

  if (isLifecycleAiDraftsEnabled()) {
    const pending = await repo.lifecycleDrafts.find({
      where: [
        ["enrolmentId", "==", enrolmentId],
        ["status", "==", "pending"],
      ],
      limit: 1,
    });
    if (pending[0]) {
      const r = await prepareDraft(ctx, pending[0].id, { db: deps.db, now: deps.now, generate: deps.generate, fetchContext: deps.fetchContext });
      if (r === "busy") return { ok: false, error: "busy" };
      if (r === "prepared") return { ok: true, outcome: "draft_prepared" };
      if (r === "fallback") return { ok: true, outcome: "draft_fallback" };
      // superseded: the prediction changed — carry on and send what's next now.
    }
  }

  const nowMs = clock();
  const version = await repo.lifecycleVersions.getById(enrolment.versionId);
  const primed = await repo.lifecycleEnrolments.claim(enrolmentId, (cur) => {
    if (cur.status !== "active") return null;
    if (cur.leaseUntil && cur.leaseUntil > iso(nowMs)) return null;
    // Parked AT a wait (not yet scheduled past it): skip that wait too.
    const at = cur.cursor?.nodeId;
    const waiting = version && at && version.graph.nodes.find((n) => n.id === at)?.type === "wait";
    return {
      ...(waiting ? { cursor: cursorOf(nextNodeId(version.graph, at)) } : {}),
      nextRunAt: iso(nowMs),
      windowExemptUntil: iso(nowMs + 10 * 60_000),
      log: withLog(cur.log, [{ at: iso(nowMs), event: "run_now", detail: null }]),
      updatedAt: iso(nowMs),
    };
  });
  if (!primed) return { ok: false, error: "busy" };
  return { ok: true, outcome: await processEnrolment(ctx, enrolmentId, deps, { seed: primed }) };
}
