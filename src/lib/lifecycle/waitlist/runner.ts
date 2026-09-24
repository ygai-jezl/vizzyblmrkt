import { randomUUID } from "node:crypto";
import { claimLifecycleSend, forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import {
  isWaitlistJourney,
  type DeliveryMode,
  type LifecycleJourney,
  type LifecycleSettings,
  type LifecycleVersion,
  type WaitlistEnrolment,
  type WaitlistHeldReason,
} from "@/lib/types/lifecycle";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/email";
import { isSuppressed } from "@/lib/email/suppression";
import { journeyFooterValues, unsubscribeLinks } from "@/lib/email/footer";
import { recordEmailEvent } from "@/lib/email/events";
import { resolveSender } from "@/lib/email/sender";
import { compileJourneyEmail } from "@/lib/agents/compiler";
import { syncSignupToWeekly } from "@/lib/mailchimp";
import { computeRanks } from "@/lib/waitlist/rank";
import { decideNext, type WalkEnv, type WalkState } from "../planner";
import { walkStateOf } from "../walk";
import { personalOffsetMinutes, resolveTimezone } from "../sendWindow";
import { isTestRecipient, lowestMode } from "../policy";
import { COUNTER_TTL_MS, counterDocId, utcDayKey } from "../enrol";
import {
  iso,
  leaseEnrolment,
  nextUtcMidnight,
  openRun,
  runWalkLoop,
  type DeliverResult,
  type EnrolmentRunOutcome,
  type SendDecision,
} from "../enrolmentRun";
import { isWaitlistEngineEnabled } from "./flags";
import { pickWaitlistItem } from "./pick";

/**
 * The runner for WAITLIST journeys on the lifecycle engine (engine move D2): a
 * launch's verified signups, emailed the way the original waitlist engine
 * emails them (its renderer, sender, unsubscribe links and footer, tracking,
 * `signup.*` conditions and A/B allocation), with the lifecycle engine's
 * guarantees (versions, one lease per person, exactly-once-or-never sends).
 *
 * Differences from product journeys: no product context, consent basis,
 * frequency cap, postal-address or verified-sender holds, no hard stop, and
 * `LIFECYCLE_MODE_CEILING` doesn't apply (it holds product journeys in prod).
 * Waitlist enrolments live in their own collection with their own due queue.
 * A paused journey or archived launch PARKS each person (out of the queue);
 * turning the journey back on releases them (./enrol.ts). The kill switch
 * (WAITLIST_ENGINE_ENABLED) holds everyone where they are; nobody is dropped.
 */

/** Re-check a blocked enrolment (test mode, no shadow inbox) this often. */
const HOLD_MS = 30 * 60_000;
/** Due waitlist enrolments processed per tenant per tick (every 2 minutes). */
export const WAITLIST_DUE_LIMIT = 200;
const RUN_BUDGET_MS = 80_000;
const CONCURRENCY = 8;
const NO_USER = { traits: {}, steps: {}, milestones: {}, consent: null };
const NO_CATALOG = { onboardingSteps: [] };

export interface WaitlistRunnerDeps {
  db?: FirestoreLike;
  now?: () => number;
  send?: (msg: EmailMessage) => Promise<EmailResult>;
  /** The weekly-newsletter hand-off (tests inject a stub). */
  syncWeekly?: typeof syncSignupToWeekly;
  budgetMs?: number;
}

/** Per-tick memo of what many enrolments share. */
export class WaitlistRunCache {
  private tenantP?: Promise<Tenant | null>;
  private readonly journeys = new Map<string, Promise<LifecycleJourney | null>>();
  private readonly versions = new Map<string, Promise<LifecycleVersion | null>>();
  private readonly campaigns = new Map<string, Promise<Campaign | null>>();
  private readonly ranks = new Map<string, Promise<Map<string, number>>>();

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
  campaign(id: string) {
    return this.memo(this.campaigns, id, () => forTenant(this.ctx, this.db).campaigns.getById(id));
  }
  /** Waitlist rank by signup id (for `signup.rank` and the {{rank}} merge tag), once per launch per tick. */
  rankOf(campaignId: string) {
    return this.memo(this.ranks, campaignId, () => computeRanks(this.ctx, campaignId, this.db));
  }
}

interface Scope {
  ctx: TenantContext;
  deps: WaitlistRunnerDeps;
  cache: WaitlistRunCache;
  enrolmentId: string;
  leaseId: string;
  journey: LifecycleJourney;
  campaign: Campaign;
  signup: Signup & { email: string };
  rank: number | undefined;
  settings: LifecycleSettings;
  mode: DeliveryMode;
  nowMs: number;
}

/**
 * Process ONE waitlist enrolment if it's due and not leased elsewhere. Safe to
 * call from overlapping ticks: the lease makes it single-flight.
 */
export async function processWaitlistEnrolment(
  ctx: TenantContext,
  enrolmentId: string,
  deps: WaitlistRunnerDeps = {},
  opts: { cache?: WaitlistRunCache; seed?: WaitlistEnrolment } = {},
): Promise<EnrolmentRunOutcome> {
  // The kill switch: nothing is touched while it's off, so everyone waits where they are.
  if (!isWaitlistEngineEnabled()) return "held";
  const clock = deps.now ?? Date.now;
  const cache = opts.cache ?? new WaitlistRunCache(ctx, deps.db);
  const repo = forTenant(ctx, deps.db);
  const nowMs = clock();

  const seed = opts.seed ?? (await repo.waitlistEnrolments.getById(enrolmentId));
  if (!seed || seed.status !== "active") return "not_due";
  const version = await cache.version(seed.versionId);

  const leaseId = randomUUID();
  const leased = await leaseEnrolment(repo.waitlistEnrolments, enrolmentId, { nowMs, leaseId, version });
  if (!leased) return "not_due";
  const run = openRun(repo.waitlistEnrolments, enrolmentId, { leaseId, nowMs, clock, label: `${ctx.tenantId}/${enrolmentId}` });
  const { log, stop, commit } = run;
  /** Out of the queue until the journey is turned back on (released in batches then). */
  const park = async (reason: WaitlistHeldReason): Promise<EnrolmentRunOutcome> => {
    log(reason);
    return (await commit({ nextRunAt: null, failures: 0, heldReason: reason, heldAt: iso(nowMs) })) ? "held" : "lost_lease";
  };

  try {
    if (!version) return await stop("version_missing");
    const journey = await cache.journey(leased.journeyId);
    if (!journey || journey.status === "archived" || !isWaitlistJourney(journey)) return await stop("journey_archived");
    const campaign = await cache.campaign(leased.campaignId);
    if (!campaign) return await stop("launch_deleted");

    const signup = await repo.signups.getById(leased.signupId);
    if (!signup) {
      // Deleted: the enrolment goes too, so a person added again (same id) can rejoin.
      await repo.waitlistEnrolments.delete(enrolmentId).catch(() => {});
      return "exited";
    }
    // Unverified and unsubscribed people leave before any hold, as on the original engine.
    if (signup.status !== "verified_active" || !signup.email) return await stop("not_verified");
    if (await isSuppressed(ctx, signup.email, deps.db)) return await stop("unsubscribed");
    // One engine per person: someone the original engine emails never gets these
    // (a shadow rehearsal only ever mails the operator's inbox).
    if (!leased.rehearsal && signup.journeyEngine === "legacy") return await stop("on_original_engine");

    if (campaign.archivedAt) return await park("launch_archived");
    if (journey.status !== "active") return await park("journey_paused");

    const ranks = await cache.rankOf(campaign.id);
    const settings = version.settings;
    const policy = settings.sendPolicy;
    const tz = resolveTimezone(policy.fallbackTimezone);
    const offsetMin = personalOffsetMinutes(signup.id, policy);
    const anchorMs = Date.parse(leased.anchorAt);
    const person = { signup, campaign, rank: ranks.get(signup.id) };
    const excluded = new Set<string>();
    const env = (state: WalkState): WalkEnv => ({
      graph: version.graph,
      pools: version.pools,
      policy,
      tz,
      offsetMin,
      excluded,
      recipientAt: (atMs) => ({
        user: NO_USER,
        catalog: NO_CATALOG,
        context: null,
        emailsSent: state.sent.filter((x) => x.status !== "skipped").length,
        enrolledAtMs: anchorMs,
        nowMs: atMs,
        waitlist: person,
      }),
      pickItem: (p) =>
        pickWaitlistItem({ ...p, signupId: signup.id, winners: journey.abWinners, excluded: p.excluded }),
    });

    const mode = lowestMode(leased.mode, journey.deliveryMode);
    const scope: Scope = {
      ctx,
      deps,
      cache,
      enrolmentId,
      leaseId,
      journey,
      campaign,
      signup: { ...signup, email: signup.email },
      rank: person.rank,
      settings,
      mode,
      nowMs,
    };
    const state = walkStateOf(leased, nowMs);
    return await runWalkLoop(run, decideNext(state, env(state)), {
      enrolment: leased,
      mode,
      excluded,
      clock,
      walk: (s) => decideNext(s, env(s)),
      deliver: (d) => deliver(scope, d),
      beforeComplete: async (d) => {
        // A weekly exit hands the person to the launch's weekly newsletter (never
        // from a shadow rehearsal — the person didn't really get the journey).
        const node = d.nodeId ? version.graph.nodes.find((n) => n.id === d.nodeId) : undefined;
        if (node?.data.exitTarget !== "weekly" || mode === "shadow") return;
        const r = await (deps.syncWeekly ?? syncSignupToWeekly)(ctx, campaign, signup);
        log("weekly_newsletter", r.ok ? "subscribed" : (r.reason ?? "not subscribed"));
      },
    });
  } catch (err) {
    return run.fail(err, leased.failures);
  }
}

async function deliver(s: Scope, d: SendDecision): Promise<DeliverResult> {
  const { ctx, deps, journey, campaign, signup, settings, mode } = s;
  const clock = deps.now ?? Date.now;
  const holdFor = (ms: number, event: string, detail?: string): DeliverResult => ({ kind: "hold", untilMs: s.nowMs + ms, event, detail });

  // Who actually receives it, by delivery mode.
  let to = signup.email;
  if (mode === "test" && !isTestRecipient(journey, { externalUserId: signup.id, email: signup.email })) {
    return holdFor(HOLD_MS, "mode_blocked", "test mode: not a test recipient");
  }
  if (mode === "shadow") {
    if (!journey.shadowInbox) return holdFor(HOLD_MS, "no_shadow_inbox");
    to = journey.shadowInbox;
  }

  // Rendered and sent exactly as the original engine does. Shadow mail carries
  // no real unsubscribe token (the operator's inbox must never be able to
  // unsubscribe the real person).
  const tenant = await s.cache.tenant();
  const sender = resolveSender(tenant, campaign);
  const unsub =
    mode === "shadow"
      ? { pageUrl: "", apiUrl: "" }
      : unsubscribeLinks({ tenantId: ctx.tenantId, campaignId: campaign.id, signupId: signup.id, email: signup.email });
  const footer = journeyFooterValues({ tenant, campaign, unsubscribeUrl: unsub.pageUrl });
  const email = compileJourneyEmail(
    { subject: d.item.subject, body: d.item.body, heroImageUrl: d.item.heroImageUrl ?? null },
    { signup, campaign, rank: s.rank, footer },
  );

  // Claim: the day's send slot + pendingSend, in one transaction.
  const atMs = clock();
  const counterId = counterDocId(journey.id, atMs);
  const claim = await claimLifecycleSend(
    ctx,
    {
      collection: "waitlist_enrolments",
      enrolmentId: s.enrolmentId,
      leaseId: s.leaseId,
      pendingSend: { nodeId: d.nodeId, poolId: d.pool.id, itemId: d.item.id, at: iso(atMs) },
      counter: { id: counterId, journeyId: journey.id, day: utcDayKey(atMs), cap: journey.caps.sendsPerDay, ttlAt: new Date(atMs + COUNTER_TTL_MS) },
      updatedAt: iso(atMs),
    },
    deps.db,
  );
  if (claim === "lost_lease") return { kind: "lost_lease" };
  // Over the day's cap: tomorrow (UTC). Nobody is ever dropped for a cap.
  if (claim === "capped") return { kind: "hold", untilMs: nextUtcMidnight(atMs), event: "daily_cap" };
  if (claim === "declined") return { kind: "skipped", reason: "declined" };

  const shadow = mode === "shadow";
  const result = await (deps.send ?? sendEmail)({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    ...(unsub.apiUrl ? { listUnsubscribe: { url: unsub.apiUrl, oneClick: true } } : {}),
    track: { opens: settings.tracking.opens, clicks: settings.tracking.clicks },
    // Shadow mail isn't attributed: opens in the operator's inbox aren't the person's.
    ...(shadow
      ? { tags: ["lifecycle-shadow"] }
      : {
          tags: ["journey", `node-${d.nodeId}`],
          metadata: {
            tenantId: ctx.tenantId,
            campaignId: campaign.id,
            journeyId: journey.id,
            nodeId: d.nodeId,
            signupId: signup.id,
            variantId: d.item.id,
            recipientKind: "signup",
          },
        }),
  }).catch(
    // sendEmail doesn't throw; if it ever does, the message may have gone out.
    (err): EmailResult => ({ sent: false, provider: "mandrill", reason: err instanceof Error ? err.message.slice(0, 120) : "error", ambiguous: true }),
  );

  if (result.sent || result.provider === "log" || result.ambiguous) {
    // Recorded as the original engine records it (also for the log provider and
    // an ambiguous answer), so launch analytics count it the same way.
    if (!shadow) {
      await recordEmailEvent(
        ctx,
        {
          campaignId: campaign.id,
          recipientKind: "signup",
          journeyId: journey.id,
          nodeId: d.nodeId,
          signupId: signup.id,
          variantId: d.item.id,
          type: "send",
          ts: iso(atMs),
          mandrillMessageId: result.id ?? null,
        },
        deps.db,
      ).catch(() => {});
    }
    if (result.sent || result.provider === "log") {
      return { kind: "sent", status: "sent", reason: result.sent ? null : "log provider (not delivered)", insightId: null, atMs };
    }
    return { kind: "sent", status: "unknown", reason: result.reason ?? "ambiguous", insightId: null, atMs };
  }

  // A definite failure: nothing went out, so give the day's slot back.
  await forTenant(ctx, deps.db)
    .lifecycleCounters.claim(counterId, (cur) => ({ sends: Math.max(0, cur.sends - 1) }))
    .catch(() => {});
  return { kind: "failed", reason: `${result.provider}: ${result.reason ?? "failed"}` };
}

// ---- Tick ----------------------------------------------------------------------------------

export interface WaitlistDrainResult {
  due: number;
  outcomes: Partial<Record<EnrolmentRunOutcome, number>>;
  deferred: number;
}

/** Drain one tenant's due waitlist enrolments (8 at a time). Nothing runs while the kill switch is off. */
export async function drainWaitlistTenant(
  ctx: TenantContext,
  deps: WaitlistRunnerDeps = {},
  deadlineAt?: number,
): Promise<WaitlistDrainResult> {
  if (!isWaitlistEngineEnabled()) return { due: 0, outcomes: {}, deferred: 0 };
  const clock = deps.now ?? Date.now;
  const deadline = deadlineAt ?? clock() + (deps.budgetMs ?? RUN_BUDGET_MS);
  const due = await forTenant(ctx, deps.db).waitlistEnrolments.find({
    where: [
      ["status", "==", "active"],
      ["nextRunAt", "<=", iso(clock())],
    ],
    orderBy: [["nextRunAt", "asc"]],
    limit: WAITLIST_DUE_LIMIT,
  });
  const cache = new WaitlistRunCache(ctx, deps.db);
  const outcomes: WaitlistDrainResult["outcomes"] = {};
  let deferred = 0;
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const e = due[next++]!;
      if (clock() >= deadline) {
        deferred += 1;
        continue;
      }
      const o = await processWaitlistEnrolment(ctx, e.id, deps, { cache, seed: e }).catch((err) => {
        console.error(`[lifecycle] waitlist ${ctx.tenantId}/${e.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
        return "failed" as const;
      });
      outcomes[o] = (outcomes[o] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  return { due: due.length, outcomes, deferred };
}
