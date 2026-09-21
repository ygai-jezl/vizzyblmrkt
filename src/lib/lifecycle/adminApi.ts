import { z } from "zod";
import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { LifecycleEnrolment, LifecycleJourney } from "@/lib/types/lifecycle";
import { ConsentBasis } from "@/lib/types/productConnection";
import { zodReason } from "@/lib/connect/protocol";
import { productUserDocId } from "@/lib/connect/profile";
import { validateLifecycleDraft } from "./graph";
import { planTimeline } from "./planner";
import { personalOffsetMinutes, resolveTimezone } from "./sendWindow";
import {
  createLifecycleJourney,
  getLifecycleJourney,
  listLifecycleJourneys,
  publishLifecycleJourney,
  saveLifecycleDraft,
  setLifecycleJourneyStatus,
  updateLifecycleDelivery,
  type ServiceResult,
} from "./service";
import { enrolUser, versionDocId } from "./enrol";
import { lifecycleSender } from "./policy";
import { isLifecycleAiDraftsEnabled, isLifecycleChatAuthoringEnabled, lifecycleModeCeiling } from "./flags";
import { runEnrolmentNow, type RunnerDeps } from "./runner";
import { architectLifecycleDraft } from "./architect";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";

/**
 * The Lifecycle → Journeys admin API (thin routes in src/app/api/admin/lifecycle
 * call these). Each returns `{ status, body }`. Reads are open to members;
 * anything that changes state is admin-only (enforced by the route gate).
 */

export type ApiResult = { status: number; body: unknown };

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, detail?: unknown): ApiResult => ({
  status,
  body: detail === undefined ? { error } : { error, detail },
});
function fromService<T>(r: ServiceResult<T>, map: (v: T) => unknown, status = 200): ApiResult {
  return r.ok ? ok(map(r.value), status) : fail(r.status, r.error, r.detail);
}

const DAY_MS = 86_400_000;

async function loadJourney(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<LifecycleJourney | null> {
  const j = await getLifecycleJourney(ctx, id, db);
  return j && j.status !== "archived" ? j : null;
}

// ---- Journeys ----------------------------------------------------------------------------

export async function listJourneys(ctx: TenantContext, opts: { connectionId?: string }, db?: FirestoreLike): Promise<ApiResult> {
  const [journeys, connections] = await Promise.all([
    listLifecycleJourneys(ctx, opts, db),
    forTenant(ctx, db).productConnections.find({ limit: 100 }),
  ]);
  const names = new Map(connections.map((c) => [c.id, c.name]));
  return ok({
    journeys: journeys
      .filter((j) => j.status !== "archived")
      .map((j) => ({
        id: j.id,
        name: j.name,
        connectionId: j.connectionId,
        connectionName: names.get(j.connectionId) ?? null,
        status: j.status,
        deliveryMode: j.deliveryMode,
        publishedVersion: j.publishedVersion,
        authoredBy: j.authoredBy,
        updatedAt: j.updatedAt,
      })),
    connections: connections
      .filter((c) => c.status !== "revoked")
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind, stepCount: c.catalog.onboardingSteps.length })),
  });
}

export async function createJourney(ctx: TenantContext, input: unknown, db?: FirestoreLike): Promise<ApiResult> {
  return fromService(await createLifecycleJourney(ctx, input, { db }), (v) => v, 201);
}

export async function getJourneyDetail(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const journey = await loadJourney(ctx, id, db);
  if (!journey) return fail(404, "not_found");
  const repo = forTenant(ctx, db);
  const [connection, version, tenant] = await Promise.all([
    repo.productConnections.getById(journey.connectionId),
    journey.publishedVersion ? repo.lifecycleVersions.getById(versionDocId(id, journey.publishedVersion)) : null,
    getTenantById(ctx.tenantId, db).catch(() => null),
  ]);
  const sender = lifecycleSender(tenant, journey.draft.settings.sender);
  return ok({
    journey,
    connection: connection
      ? {
          id: connection.id,
          name: connection.name,
          kind: connection.kind,
          status: connection.status,
          catalog: connection.catalog,
          linkDomains: connection.linkDomains,
          defaults: connection.defaults,
          contextConfigured: Boolean(connection.contextEndpoint?.enabled),
          sandboxUsers: (connection.sandbox?.users ?? []).map((u) => ({ userId: u.userId, email: u.email, firstName: u.firstName ?? null })),
        }
      : null,
    version: version ? { version: version.version, publishedAt: version.publishedAt, publishedBy: version.publishedBy ?? null } : null,
    issues: connection ? validateLifecycleDraft(journey.draft, connection.catalog).issues : [],
    sender: { verified: sender.verified, fromEmail: sender.fromEmail ?? null, fromName: sender.fromName ?? null },
    postalAddress: tenant?.emailSenderConfig?.postalAddress ?? null,
    modeCeiling: lifecycleModeCeiling(),
    features: { chatAuthoring: isLifecycleChatAuthoringEnabled(), aiLines: isLifecycleAiDraftsEnabled() },
  });
}

export async function saveDraft(ctx: TenantContext, id: string, input: unknown, db?: FirestoreLike): Promise<ApiResult> {
  return fromService(await saveLifecycleDraft(ctx, id, input, { db, authoredBy: "human" }), (v) => v);
}

export async function publishJourney(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  return fromService(await publishLifecycleJourney(ctx, id, { db }), (v) => ({
    journey: v.journey,
    version: { version: v.version.version, publishedAt: v.version.publishedAt },
  }));
}

const StatusInput = z.object({ status: z.enum(["active", "paused", "archived"]) });

export async function setJourneyStatus(ctx: TenantContext, id: string, input: unknown, db?: FirestoreLike): Promise<ApiResult> {
  const parsed = StatusInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  return fromService(await setLifecycleJourneyStatus(ctx, id, parsed.data.status, { db }), (journey) => ({ journey }));
}

export async function patchJourney(ctx: TenantContext, id: string, input: unknown, db?: FirestoreLike): Promise<ApiResult> {
  return fromService(await updateLifecycleDelivery(ctx, id, input, { db }), (journey) => ({ journey }));
}

// ---- Enrolments --------------------------------------------------------------------------

export async function listEnrolments(
  ctx: TenantContext,
  journeyId: string,
  opts: { limit?: number },
  db?: FirestoreLike,
): Promise<ApiResult> {
  const journey = await loadJourney(ctx, journeyId, db);
  if (!journey) return fail(404, "not_found");
  const repo = forTenant(ctx, db);
  const rows = await repo.lifecycleEnrolments.find({
    where: [["journeyId", "==", journeyId]],
    orderBy: [["createdAt", "desc"]],
    limit: Math.min(Math.max(opts.limit ?? 100, 1), 200),
  });
  const users = new Map(
    (await Promise.all([...new Set(rows.map((r) => r.productUserId))].map((uid) => repo.productUsers.getById(uid)))).flatMap(
      (u) => (u ? [[u.id, u] as const] : []),
    ),
  );
  return ok({
    enrolments: rows.map((e) => {
      const u = users.get(e.productUserId);
      return { ...e, user: u ? { email: u.email ?? null, firstName: u.firstName ?? null, status: u.status } : null };
    }),
  });
}

const EnrolInput = z.object({ userId: z.string().trim().min(1).max(256) });

/** Enrol one existing product user by hand (their own product user id). */
export async function enrolByHand(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<ApiResult> {
  const parsed = EnrolInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const journey = await loadJourney(ctx, journeyId, db);
  if (!journey) return fail(404, "not_found");
  if (journey.status !== "active" || !journey.publishedVersion) return fail(409, "journey_not_active");
  const repo = forTenant(ctx, db);
  const [version, user] = await Promise.all([
    repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion)),
    repo.productUsers.getById(productUserDocId(journey.connectionId, parsed.data.userId)),
  ]);
  if (!version) return fail(409, "version_missing");
  if (!user) return fail(404, "user_not_found");
  const r = await enrolUser(
    ctx,
    { journey, version, user, source: "manual", anchorAt: new Date(nowMs).toISOString() },
    { db, nowMs },
  );
  if (r.outcome === "enrolled") return ok({ enrolmentId: r.enrolmentId }, 201);
  if (r.outcome === "duplicate") return fail(409, "already_enrolled", r.enrolmentId);
  return fail(409, r.reason);
}

export async function runNow(ctx: TenantContext, enrolmentId: string, deps: RunnerDeps = {}): Promise<ApiResult> {
  const r = await runEnrolmentNow(ctx, enrolmentId, deps);
  if (r.ok) return ok({ outcome: r.outcome });
  return fail(r.error === "not_found" ? 404 : 409, r.error);
}

/** Take one user out of a journey (e.g. they asked by email). */
export async function stopEnrolment(
  ctx: TenantContext,
  enrolmentId: string,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<ApiResult> {
  const now = new Date(nowMs).toISOString();
  const repo = forTenant(ctx, db);
  const existing = await repo.lifecycleEnrolments.getById(enrolmentId);
  if (!existing) return fail(404, "not_found");
  const done = await repo.lifecycleEnrolments.claim(enrolmentId, (cur) => {
    if (cur.status !== "active" || (cur.leaseUntil && cur.leaseUntil > now)) return null;
    return {
      status: "exited",
      stopReason: "stopped_by_admin",
      cursor: null,
      nextRunAt: null,
      log: [...cur.log, { at: now, event: "stopped", detail: `by ${ctx.email ?? ctx.userId ?? "admin"}` }].slice(-40),
      updatedAt: now,
    };
  });
  return done ? ok({ enrolment: done }) : fail(409, existing.status === "active" ? "busy" : "not_active");
}

// ---- Timeline preview --------------------------------------------------------------------

const PreviewInput = z.object({
  timezone: z.string().max(64).optional(),
  anchorAt: z.iso.datetime({ offset: true }).optional(),
  /** Step id → hours after sign-up when the user completes it (absent = never). */
  stepsDoneAfterHours: z.record(z.string().max(64), z.number().min(0).max(60 * 24)).default({}),
  facts: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  consentBasis: ConsentBasis.optional(),
  /** The product's user id, for the same send-minute the runner would pick. */
  userId: z.string().max(256).optional(),
});

/** Dry-run the DRAFT for one imagined user: when each email would go out. */
export async function previewJourney(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<ApiResult> {
  const parsed = PreviewInput.safeParse(input ?? {});
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const journey = await loadJourney(ctx, journeyId, db);
  if (!journey) return fail(404, "not_found");
  const connection = await forTenant(ctx, db).productConnections.getById(journey.connectionId);
  if (!connection) return fail(404, "connection_not_found");

  const p = parsed.data;
  const policy = journey.draft.settings.sendPolicy;
  const tz = resolveTimezone(p.timezone, connection.defaults.timezone, policy.fallbackTimezone);
  const anchorMs = p.anchorAt ? Date.parse(p.anchorAt) : nowMs;
  const seed = p.userId ? productUserDocId(connection.id, p.userId) : `preview:${journeyId}`;
  const steps = planTimeline(
    { graph: journey.draft.graph, pools: journey.draft.pools, policy },
    connection.catalog,
    {
      anchorMs,
      tz,
      offsetMin: personalOffsetMinutes(seed, policy),
      stepsDoneAt: Object.fromEntries(Object.entries(p.stepsDoneAfterHours).map(([k, h]) => [k, anchorMs + h * 3600_000])),
      facts: p.facts,
      consentBasis: p.consentBasis,
    },
  );
  return ok({
    timezone: tz,
    anchorAt: new Date(anchorMs).toISOString(),
    steps: steps.map((s) => ({ ...s, at: new Date(s.atMs).toISOString(), day: Math.floor((s.atMs - anchorMs) / DAY_MS) + 1 })),
  });
}

// ---- Analytics ---------------------------------------------------------------------------

type ItemStats = {
  poolId: string;
  itemId: string;
  label: string;
  sent: number;
  unknown: number;
  skipped: number;
  /** AI-line emails: how many carried the reviewed line vs the standard version, and why. */
  ai: number;
  standard: number;
  fallbackReasons: Record<string, number>;
  byMode: Record<string, number>;
  opens: number;
  clicks: number;
  unsubscribes: number;
  bounces: number;
  complaints: number;
};

export async function journeyAnalytics(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Promise<ApiResult> {
  const journey = await loadJourney(ctx, journeyId, db);
  if (!journey) return fail(404, "not_found");
  const repo = forTenant(ctx, db);
  const [enrolments, events, connection] = await Promise.all([
    repo.lifecycleEnrolments.find({ where: [["journeyId", "==", journeyId]], limit: 2000 }),
    repo.emailEvents.find({ where: [["journeyId", "==", journeyId]], limit: 5000 }),
    repo.productConnections.getById(journey.connectionId),
  ]);

  const labels = new Map<string, string>();
  for (const pool of journey.draft.pools) for (const item of pool.items) labels.set(`${pool.id}:${item.id}`, item.label);
  const items = new Map<string, ItemStats>();
  const itemFor = (poolId: string, itemId: string): ItemStats => {
    const key = `${poolId}:${itemId}`;
    let s = items.get(key);
    if (!s) {
      s = {
        poolId,
        itemId,
        label: labels.get(key) ?? itemId,
        sent: 0,
        unknown: 0,
        skipped: 0,
        ai: 0,
        standard: 0,
        fallbackReasons: {},
        byMode: {},
        opens: 0,
        clicks: 0,
        unsubscribes: 0,
        bounces: 0,
        complaints: 0,
      };
      items.set(key, s);
    }
    return s;
  };
  const byStatus: Record<LifecycleEnrolment["status"], number> = { active: 0, completed: 0, exited: 0 };
  const stopReasons: Record<string, number> = {};
  const poolOfItem = new Map<string, string>();
  for (const e of enrolments) {
    byStatus[e.status] += 1;
    if (e.status === "exited" && e.stopReason) stopReasons[e.stopReason] = (stopReasons[e.stopReason] ?? 0) + 1;
    for (const s of e.sentItems) {
      const st = itemFor(s.poolId, s.itemId);
      poolOfItem.set(s.itemId, s.poolId);
      if (s.status === "skipped") {
        st.skipped += 1;
        continue;
      }
      if (s.status === "sent") st.sent += 1;
      else st.unknown += 1;
      st.byMode[s.mode] = (st.byMode[s.mode] ?? 0) + 1;
      if (s.version === "ai") st.ai += 1;
      if (s.version === "fallback") {
        st.standard += 1;
        const why = (s.reason ?? "unknown").split(" · ")[0]!;
        st.fallbackReasons[why] = (st.fallbackReasons[why] ?? 0) + 1;
      }
    }
  }
  // Engagement from the provider's webhooks (unique per recipient + item).
  for (const ev of events) {
    const poolId = poolOfItem.get(ev.variantId);
    if (!poolId) continue;
    const st = itemFor(poolId, ev.variantId);
    if (ev.type === "open") st.opens += 1;
    else if (ev.type === "click") st.clicks += 1;
    else if (ev.type === "unsub") st.unsubscribes += 1;
    else if (ev.type === "bounce" || ev.type === "soft_bounce" || ev.type === "reject") st.bounces += 1;
    else if (ev.type === "spam") st.complaints += 1;
  }

  // The goal: every onboarding step done within 7 days of enrolling.
  const steps = connection?.catalog.onboardingSteps ?? [];
  let eligible = 0;
  let onboarded = 0;
  const hoursToOnboarded: number[] = [];
  if (steps.length > 0 && enrolments.length > 0) {
    const users = await repo.productUsers.find({ where: [["connectionId", "==", journey.connectionId]], limit: 5000 });
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const e of enrolments) {
      const u = byId.get(e.productUserId);
      if (!u) continue;
      eligible += 1;
      const done = steps.map((s) => u.steps[s.id]?.doneAt).filter((d): d is string => Boolean(d));
      if (done.length < steps.length) continue;
      const last = Math.max(...done.map((d) => Date.parse(d)));
      const hours = (last - Date.parse(e.anchorAt)) / 3600_000;
      if (hours <= 7 * 24) {
        onboarded += 1;
        hoursToOnboarded.push(Math.max(0, hours));
      }
    }
  }
  hoursToOnboarded.sort((a, b) => a - b);
  const median = hoursToOnboarded.length ? hoursToOnboarded[Math.floor((hoursToOnboarded.length - 1) / 2)]! : null;

  return ok({
    enrolments: { total: enrolments.length, ...byStatus, stopReasons },
    items: [...items.values()].sort((a, b) => a.poolId.localeCompare(b.poolId) || a.itemId.localeCompare(b.itemId)),
    goal: {
      label: "All onboarding steps done within 7 days",
      eligible,
      reached: onboarded,
      rate: eligible ? onboarded / eligible : null,
      medianHoursToOnboarded: median === null ? null : Math.round(median * 10) / 10,
    },
    truncated: enrolments.length >= 2000 || events.length >= 5000,
  });
}

// ---- Generate (the canvas's AI button) -----------------------------------------------------

const GenerateInput = z.object({
  brief: z.string().max(2000).default(""),
  options: z.unknown().optional(),
});

/** Rebuild the draft from the template with fresh on-brand copy (the architect Vizzy uses). */
export async function generateJourneyDraft(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  deps: { db?: FirestoreLike; generate?: (prompt: string) => Promise<string | null> } = {},
): Promise<ApiResult> {
  const parsed = GenerateInput.safeParse(input ?? {});
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const journey = await loadJourney(ctx, journeyId, deps.db);
  if (!journey) return fail(404, "not_found");
  const [connection, tenant] = await Promise.all([
    forTenant(ctx, deps.db).productConnections.getById(journey.connectionId),
    getTenantById(ctx.tenantId, deps.db).catch(() => null),
  ]);
  if (!connection) return fail(404, "connection_not_found");
  const built = await architectLifecycleDraft({
    connection,
    options: parsed.data.options,
    brief: parsed.data.brief,
    brandVoice: resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice }),
    generate: deps.generate,
  });
  if ("error" in built) return fail(422, "invalid_options", built.detail);
  const saved = await saveLifecycleDraft(ctx, journeyId, built.draft, { db: deps.db, authoredBy: "human" });
  if (!saved.ok) return fail(saved.status, saved.error, saved.detail);
  return ok({ journey: saved.value.journey, issues: saved.value.issues, notes: built.notes });
}
