import { randomBytes } from "node:crypto";
import { z } from "zod";
import { forTenant, getTenantById, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import {
  DeliveryMode,
  isWaitlistJourney,
  LifecycleDraftSchema,
  LifecycleSettingsSchema,
  SendPolicySchema,
  type LifecycleDraft,
  type LifecycleJourney,
  type LifecycleVersion,
} from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import { zodReason } from "@/lib/connect/protocol";
import { NO_CATALOG, validateLifecycleDraft, type GraphIssue } from "./graph";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";
import { versionDocId } from "./enrol";
import { isOwnOrVerifiedAddress, lifecycleSender } from "./policy";
import { waitlistJourneyId } from "./waitlist/ids";
import { backfillWaitlistJourney, releaseHeldWaitlistEnrolments, type WaitlistReleaseSummary } from "./waitlist/enrol";

/**
 * Lifecycle journeys: create, edit the draft, publish immutable versions, and
 * control delivery. The canvas UI and chat authoring (M4a) both go through
 * here; neither can publish on its own — publishing is a separate, human action.
 */

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: unknown };

const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (status: number, error: string, detail?: unknown): ServiceResult<never> => ({ ok: false, status, error, detail });

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function newJourneyId(): string {
  const bytes = randomBytes(20);
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return `lcj_${out}`;
}

export const LIFECYCLE_TEMPLATES = ["product_onboarding", "blank"] as const;
export type LifecycleTemplate = (typeof LIFECYCLE_TEMPLATES)[number];

function blankDraft(): LifecycleDraft {
  return {
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Signed up" } },
        { id: "exit", type: "exit", position: { x: 260, y: 0 }, data: { label: "End" } },
      ],
      edges: [{ id: "e_trigger_out_exit", source: "trigger", target: "exit", sourceHandle: null }],
    },
    pools: [],
    settings: LifecycleSettingsSchema.parse({}),
  };
}

async function loadConnection(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ProductConnection | null> {
  return forTenant(ctx, db).productConnections.getById(id);
}

/**
 * Validate a draft for its journey's audience: a product journey against its
 * connection's catalog, a waitlist journey against its launch (signup fields).
 * `error` when the product or the launch is gone.
 */
async function validateForAudience(
  ctx: TenantContext,
  journey: LifecycleJourney,
  draft: LifecycleDraft,
  db?: FirestoreLike,
): Promise<{ ok: boolean; issues: GraphIssue[]; error?: "connection_not_found" | "launch_not_found" }> {
  if (journey.audience?.kind === "waitlist") {
    const campaign = await forTenant(ctx, db).campaigns.getById(journey.audience.campaignId);
    if (!campaign) return { ok: false, issues: [], error: "launch_not_found" };
    return validateLifecycleDraft(draft, NO_CATALOG, { audience: "waitlist" });
  }
  const connection = await loadConnection(ctx, journey.connectionId, db);
  if (!connection) return { ok: false, issues: [], error: "connection_not_found" };
  return validateLifecycleDraft(draft, connection.catalog);
}

/**
 * A new waitlist journey's settings: any time of day (like the original
 * engine), no hard stop, opens and clicks tracked.
 */
export function waitlistSettings(): LifecycleDraft["settings"] {
  return LifecycleSettingsSchema.parse({
    trigger: { event: "signup.verified", maxEventAgeHours: 72 },
    sendPolicy: SendPolicySchema.parse({ anytime: true, hardStopDays: null }),
    category: { key: "waitlist", label: "Launch updates" },
    tracking: { opens: true, clicks: true },
  });
}

/**
 * Create a launch's waitlist journey (engine move D2): one per launch, with a
 * fixed id. Starts as a draft; publishing is a separate, human action.
 */
export async function createWaitlistJourney(
  ctx: TenantContext,
  a: { campaignId: string; name?: string; draft?: LifecycleDraft },
  deps: { db?: FirestoreLike; nowMs?: number; authoredBy?: "human" | "agent" } = {},
): Promise<ServiceResult<{ journey: LifecycleJourney; issues: GraphIssue[] }>> {
  const repo = forTenant(ctx, deps.db);
  const campaign = await repo.campaigns.getById(a.campaignId);
  if (!campaign) return fail(404, "launch_not_found");
  const draft = a.draft ?? { ...blankDraft(), settings: waitlistSettings() };
  const parsed = LifecycleDraftSchema.safeParse(draft);
  if (!parsed.success) return fail(400, "invalid_draft", zodReason(parsed.error));
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  let journey: LifecycleJourney;
  try {
    journey = await repo.lifecycleJourneys.create(waitlistJourneyId(campaign.id), {
      name: (a.name ?? `${campaign.waitlistName || campaign.id} welcome emails`).slice(0, 120),
      connectionId: "",
      audience: { kind: "waitlist", campaignId: campaign.id },
      workspaceId: null,
      status: "draft",
      // Publishing a waitlist journey sends for real, as it always has.
      deliveryMode: "live",
      draft: parsed.data,
      publishedVersion: null,
      liveSince: null,
      testRecipients: { userIds: [], emails: [] },
      shadowInbox: ctx.email ?? null,
      caps: { sendsPerDay: 10_000, enrolmentsPerDay: 10_000 },
      authoredBy: deps.authoredBy ?? "human",
      createdBy: ctx.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) return fail(409, "journey_exists");
    throw err;
  }
  return ok({ journey, issues: validateLifecycleDraft(parsed.data, NO_CATALOG, { audience: "waitlist" }).issues });
}

export async function getLifecycleJourney(
  ctx: TenantContext,
  id: string,
  db?: FirestoreLike,
): Promise<LifecycleJourney | null> {
  return forTenant(ctx, db).lifecycleJourneys.getById(id);
}

export async function listLifecycleJourneys(
  ctx: TenantContext,
  opts: { connectionId?: string } = {},
  db?: FirestoreLike,
): Promise<LifecycleJourney[]> {
  const rows = await forTenant(ctx, db).lifecycleJourneys.find({
    where: opts.connectionId ? [["connectionId", "==", opts.connectionId]] : [],
    limit: 100,
  });
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const CreateJourneyInput = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().min(1).max(64),
  template: z.enum(LIFECYCLE_TEMPLATES).default("product_onboarding"),
  workspaceId: z.string().max(64).nullable().optional(),
});

export async function createLifecycleJourney(
  ctx: TenantContext,
  input: unknown,
  deps: {
    db?: FirestoreLike;
    nowMs?: number;
    authoredBy?: "human" | "agent";
    /** A ready-made draft (the architect's) instead of the template's. */
    draft?: LifecycleDraft;
  } = {},
): Promise<ServiceResult<{ journey: LifecycleJourney; issues: GraphIssue[] }>> {
  const parsed = CreateJourneyInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const connection = await loadConnection(ctx, parsed.data.connectionId, deps.db);
  if (!connection || connection.status === "revoked") return fail(404, "connection_not_found");

  const draft =
    deps.draft ?? (parsed.data.template === "blank" ? blankDraft() : buildProductOnboardingDraft(connection.catalog));
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const journey = await forTenant(ctx, deps.db).lifecycleJourneys.create(newJourneyId(), {
    name: parsed.data.name,
    connectionId: connection.id,
    workspaceId: parsed.data.workspaceId ?? null,
    status: "draft",
    deliveryMode: "test",
    draft,
    publishedVersion: null,
    liveSince: null,
    testRecipients: {
      // A sandbox's own test users are the natural test recipients.
      userIds: (connection.sandbox?.users ?? []).map((u) => u.userId).slice(0, 50),
      emails: [],
    },
    shadowInbox: ctx.email ?? null,
    caps: { sendsPerDay: 200, enrolmentsPerDay: 500 },
    authoredBy: deps.authoredBy ?? "human",
    createdBy: ctx.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return ok({ journey, issues: validateLifecycleDraft(draft, connection.catalog).issues });
}

/** Replace the DRAFT (graph + pools + settings). The published version is untouched. */
export async function saveLifecycleDraft(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number; authoredBy?: "human" | "agent" } = {},
): Promise<ServiceResult<{ journey: LifecycleJourney; issues: GraphIssue[] }>> {
  const parsed = LifecycleDraftSchema.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_draft", zodReason(parsed.error));
  const repo = forTenant(ctx, deps.db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return fail(404, "not_found");
  const checked = await validateForAudience(ctx, journey, parsed.data, deps.db);
  if (checked.error) return fail(404, checked.error);

  const updatedAt = new Date(deps.nowMs ?? Date.now()).toISOString();
  const patch = {
    draft: parsed.data,
    updatedAt,
    ...(deps.authoredBy === "agent" ? { authoredBy: "agent" as const } : {}),
  };
  await repo.lifecycleJourneys.update(journeyId, patch);
  return ok({ journey: { ...journey, ...patch }, issues: checked.issues });
}

/**
 * Publish the draft as the next immutable version and make it the live one.
 * New enrolments use it; existing enrolments stay on the version they started
 * on. A first publish activates the journey; a paused journey stays paused.
 */
export async function publishLifecycleJourney(
  ctx: TenantContext,
  journeyId: string,
  deps: {
    db?: FirestoreLike;
    nowMs?: number;
    tenant?: Tenant | null;
    /**
     * Waitlist journeys: on the FIRST publish of a launch that never ran on the
     * original engine, enrol its existing verified signups (resumably; the tick
     * finishes a big list). `false` (the engine switch) never backfills.
     */
    backfill?: boolean;
  } = {},
): Promise<ServiceResult<{ journey: LifecycleJourney; version: LifecycleVersion }>> {
  const repo = forTenant(ctx, deps.db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return fail(404, "not_found");
  const audience = journey.audience;
  const waitlist = audience?.kind === "waitlist";
  if (audience?.kind === "waitlist") {
    const campaign = await repo.campaigns.getById(audience.campaignId);
    if (!campaign) return fail(404, "launch_not_found");
    if (campaign.archivedAt) return fail(409, "launch_archived");
  } else {
    const connection = await loadConnection(ctx, journey.connectionId, deps.db);
    if (!connection || connection.status === "revoked") return fail(409, "connection_unavailable");
  }

  const draft = LifecycleDraftSchema.safeParse(journey.draft);
  if (!draft.success) return fail(422, "invalid_draft", zodReason(draft.error));
  const { ok: valid, issues } = await validateForAudience(ctx, journey, draft.data, deps.db);
  if (!valid) return fail(422, "invalid_journey", issues);

  // Waitlist journeys send from the launch's sender as they always have (its
  // fallback included); product journeys need a verified domain to go live.
  if (!waitlist && journey.deliveryMode === "live") {
    const tenant = deps.tenant !== undefined ? deps.tenant : await getTenantById(ctx.tenantId, deps.db).catch(() => null);
    if (!lifecycleSender(tenant, draft.data.settings.sender).verified) return fail(409, "sender_unverified");
  }

  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const number = (journey.publishedVersion ?? 0) + 1;
  let version: LifecycleVersion;
  try {
    version = await repo.lifecycleVersions.create(versionDocId(journey.id, number), {
      journeyId: journey.id,
      version: number,
      graph: draft.data.graph,
      pools: draft.data.pools,
      settings: draft.data.settings,
      publishedAt: now,
      publishedBy: ctx.userId ?? ctx.email ?? null,
    });
  } catch (err) {
    // Two publishes raced for the same version number.
    if (err instanceof TenantIsolationError) return fail(409, "publish_conflict");
    throw err;
  }
  const patch = {
    publishedVersion: number,
    status: journey.status === "draft" ? ("active" as const) : journey.status,
    liveSince: journey.liveSince ?? now,
    updatedAt: now,
  };
  await repo.lifecycleJourneys.update(journey.id, patch);
  const published = { ...journey, ...patch };
  if (audience?.kind === "waitlist" && journey.publishedVersion === null && deps.backfill !== false) {
    const campaign = await repo.campaigns.getById(audience.campaignId);
    const original = await repo.journeys.getById(`journey_${audience.campaignId}`);
    const neverRan = !original || original.status === "draft";
    if (campaign?.waitlistEngine === "lifecycle" && neverRan) {
      const backfill = { status: "running" as const, cursor: null, enrolled: 0, updatedAt: now };
      await repo.lifecycleJourneys.update(journey.id, { backfill });
      // A first pass now; the tick carries on with a big list.
      await backfillWaitlistJourney(
        ctx,
        { journey: { ...published, backfill }, version, campaign },
        { db: deps.db, deadlineAt: Date.now() + 15_000 },
      ).catch((err) => console.warn(`[lifecycle] backfill ${ctx.tenantId}/${journey.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`));
    }
  }
  return ok({ journey: published, version });
}

/**
 * Pause, resume or archive. Activating needs a published version. Resuming a
 * waitlist journey releases the people who waited while it was paused (paced),
 * and is refused while its launch is archived.
 */
export async function setLifecycleJourneyStatus(
  ctx: TenantContext,
  journeyId: string,
  status: "active" | "paused" | "archived",
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ServiceResult<LifecycleJourney & { released?: WaitlistReleaseSummary }>> {
  const repo = forTenant(ctx, deps.db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return fail(404, "not_found");
  if (status === "active" && !journey.publishedVersion) return fail(409, "not_published");
  if (status === "active" && journey.audience?.kind === "waitlist") {
    const campaign = await repo.campaigns.getById(journey.audience.campaignId);
    if (!campaign) return fail(404, "launch_not_found");
    if (campaign.archivedAt) return fail(409, "launch_archived");
  }
  const nowMs = deps.nowMs ?? Date.now();
  const patch = { status, updatedAt: new Date(nowMs).toISOString() };
  await repo.lifecycleJourneys.update(journeyId, patch);
  const next = { ...journey, ...patch };
  if (status === "active" && isWaitlistJourney(journey)) {
    const released = await releaseHeldWaitlistEnrolments(ctx, next, { now: nowMs, db: deps.db });
    return ok({ ...next, released });
  }
  return ok(next);
}

export const DeliveryInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  deliveryMode: DeliveryMode.optional(),
  testRecipients: z
    .object({
      userIds: z.array(z.string().min(1).max(256)).max(50),
      emails: z.array(z.string().email().max(254)).max(50),
    })
    .optional(),
  shadowInbox: z.string().email().max(254).nullable().optional(),
  caps: z
    .object({
      sendsPerDay: z.number().int().min(1).max(10000),
      enrolmentsPerDay: z.number().int().min(1).max(10000),
    })
    .optional(),
});

/**
 * Delivery settings. Shadow needs an inbox the operator controls (their own
 * address or a verified domain — shadow mail names the real recipient). Live
 * needs the published version's sender on a verified domain.
 */
export async function updateLifecycleDelivery(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number; tenant?: Tenant | null } = {},
): Promise<ServiceResult<LifecycleJourney>> {
  const parsed = DeliveryInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const repo = forTenant(ctx, deps.db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return fail(404, "not_found");
  const tenant = deps.tenant !== undefined ? deps.tenant : await getTenantById(ctx.tenantId, deps.db).catch(() => null);

  const next = { ...journey, ...parsed.data };
  if (parsed.data.shadowInbox && !isOwnOrVerifiedAddress(parsed.data.shadowInbox, { ownEmail: ctx.email, tenant })) {
    return fail(400, "shadow_inbox_not_allowed");
  }
  if (next.deliveryMode === "shadow" && !next.shadowInbox) return fail(400, "shadow_inbox_required");
  // Waitlist journeys send from the launch's sender, with its fallback, as they always have.
  if (next.deliveryMode === "live" && parsed.data.deliveryMode === "live" && !isWaitlistJourney(journey)) {
    const version = journey.publishedVersion
      ? await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion))
      : null;
    const sender = (version?.settings ?? journey.draft.settings).sender;
    if (!lifecycleSender(tenant, sender).verified) return fail(409, "sender_unverified");
  }

  const patch = { ...parsed.data, updatedAt: new Date(deps.nowMs ?? Date.now()).toISOString() };
  await repo.lifecycleJourneys.update(journeyId, patch);
  return ok({ ...journey, ...patch });
}
