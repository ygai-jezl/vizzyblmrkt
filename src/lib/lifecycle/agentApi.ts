import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { verifyCanvasContext, isCanvasAuthConfigured, tenantContextFromCanvasToken } from "@/lib/canvas/auth";
import { isEmailJourneyStyleEnabled, isEmailStyleEnabled } from "@/lib/email/flags";
import { continuesFromId, type LifecycleJourney } from "@/lib/types/lifecycle";
import { validateLifecycleDraft } from "./graph";
import { isLifecycleChatAuthoringEnabled, isLifecycleDateStartEnabled, isLifecycleEnabled, isLifecycleJourneyLinksEnabled } from "./flags";
import { isDateFactsEnabled } from "@/lib/connect/v2/flags";
import { upstreamCheck } from "./chain";
import { journeyTimeline, timelineText } from "./timeline";
import { isPersonBriefEnabled, isPersonPlansEnabled } from "@/lib/audience/flags";

/**
 * What Vizzy (the lifecycle_ops agent) may READ to build or edit a journey:
 * the tenant's connected products and their catalogs, AGGREGATE onboarding
 * stats, existing journeys, verified sending domains and workspaces — and one
 * journey's draft. Never an individual user, an email address, a test
 * recipient or the shadow inbox. Auth is the signed canvas capability token.
 */

export type ApiResult = { status: number; body: unknown };

const MAX_USERS_FOR_STATS = 2000;

export function agentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isLifecycleEnabled() || !isLifecycleChatAuthoringEnabled()) {
    return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  }
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor((s.length - 1) / 2)]! * 10) / 10;
}

/** Share of users completing each step, and the median hours from first seen to it. */
function stepStats(connection: ProductConnection, users: ProductUser[]) {
  const active = users.filter((u) => u.status === "active");
  return {
    users: active.length,
    sampled: users.length >= MAX_USERS_FOR_STATS,
    steps: [...connection.catalog.onboardingSteps]
      .sort((a, b) => a.order - b.order)
      .map((s) => {
        const hours = active.flatMap((u) => {
          const doneAt = u.steps[s.id]?.doneAt;
          if (!doneAt) return [];
          const h = (Date.parse(doneAt) - Date.parse(u.firstSeenAt)) / 3_600_000;
          return Number.isFinite(h) && h >= 0 ? [h] : [];
        });
        const done = active.filter((u) => u.steps[s.id]).length;
        return {
          id: s.id,
          label: s.label,
          completedShare: active.length ? Math.round((done / active.length) * 100) / 100 : null,
          medianHoursToComplete: median(hours),
        };
      }),
  };
}

/**
 * A journey's timeline for the agent: how many emails, over how many days, on which days and in
 * which send window — what a journey that continues from it is planned around. Null when the draft
 * can't be walked.
 */
function agentTimeline(journey: Pick<LifecycleJourney, "draft">, connection: Pick<ProductConnection, "catalog" | "defaults"> | undefined) {
  if (!connection) return null;
  try {
    const t = journeyTimeline(journey.draft, connection.catalog, { timezone: connection.defaults.timezone });
    return { summary: timelineText(t), emails: t.emails, days: t.days, emailDays: t.steps, sendDays: t.sendDays, sendTime: t.sendTime };
  } catch {
    return null;
  }
}

export async function agentLifecycleContext(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const repo = forTenant(ctx, db);
  const [connections, journeys, workspaces, tenant] = await Promise.all([
    repo.productConnections.find({ limit: 50 }),
    repo.lifecycleJourneys.find({ limit: 100 }),
    repo.workspaces.find({ limit: 50 }).catch(() => []),
    getTenantById(ctx.tenantId, db).catch(() => null),
  ]);
  const live = connections.filter((c) => c.status !== "revoked");
  const links = isLifecycleJourneyLinksEnabled();
  const connectionById = new Map(connections.map((c) => [c.id, c]));
  const withStats = await Promise.all(
    live.map(async (c) => {
      const users = await repo.productUsers.find({ where: [["connectionId", "==", c.id]], limit: MAX_USERS_FOR_STATS });
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        status: c.status,
        catalog: {
          events: c.catalog.events.map((e) => ({ name: e.name, label: e.label, description: e.description, kind: e.kind ?? null })),
          traits: c.catalog.traits.map((t) => ({ key: t.key, type: t.type, label: t.label, description: t.description })),
          onboardingSteps: [...c.catalog.onboardingSteps]
            .sort((a, b) => a.order - b.order)
            .map((s) => ({ id: s.id, label: s.label, url: s.url ?? null, completion: s.completion ?? "", kind: s.kind ?? null })),
          // What the product can report per user: branch on `fact.<id>`, ground insights in them.
          facts: (c.catalog.facts ?? []).map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit ?? null, description: f.description, kind: f.kind ?? null })),
          glossary: c.catalog.glossary,
          // The things people have several of (brands, workspaces…): what a journey's "about" can name.
          entityKinds: (c.catalog.entityKinds ?? []).map((k) => ({ kind: k.kind, label: k.label, plural: k.plural, parent: k.parent ?? null })),
        },
        contextConfigured: Boolean(c.contextEndpoint?.enabled),
        stats: stepStats(c, users),
      };
    }),
  );
  return {
    status: 200,
    body: {
      connections: withStats,
      journeys: journeys
        // Launches' welcome journeys (engine move) are authored through the launch, not here.
        .filter((j) => j.status !== "archived" && j.audience?.kind !== "waitlist")
        .map((j) => ({
          id: j.id,
          name: j.name,
          connectionId: j.connectionId,
          status: j.status,
          deliveryMode: j.deliveryMode,
          publishedVersion: j.publishedVersion,
          authoredBy: j.authoredBy,
          updatedAt: j.updatedAt,
          // Journey links: the journey it starts after (null = a product event), and its timeline.
          ...(links ? { continuesFrom: continuesFromId(j.draft.settings), timeline: agentTimeline(j, connectionById.get(j.connectionId)) } : {}),
        })),
      // A journey can start when someone finishes another one (draft_lifecycle_journey's
      // after_journey_id). Only sent while journey links are on.
      ...(links ? { journeyLinks: { enabled: true } } : {}),
      // A catalog fact can be a date, read by conditions as days_since.<id> / days_until.<id>.
      // Only sent while date facts are on.
      ...(isDateFactsEnabled() ? { dateFacts: { enabled: true } } : {}),
      // A journey can start when a date fact is a number of days ago (settings.trigger.date).
      // Only sent while that start is on.
      ...(isLifecycleDateStartEnabled() ? { dateStart: { enabled: true } } : {}),
      verifiedSendingDomains: (tenant?.emailSenderConfig?.domains ?? []).filter((d) => d.status === "verified").map((d) => d.domain),
      senderName: tenant?.emailSenderConfig?.senderName ?? null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: (w as { name?: string }).name ?? w.id })),
      // With a saved Email style, branded emails get the header band and button colour, so
      // bodies shouldn't bring their own. Only sent while the flag is on.
      ...(isEmailStyleEnabled() ? { emailStyle: { configured: Boolean(tenant?.emailStyle) } } : {}),
      // A journey can wear its own header and button colours (the journey_style kind), set
      // in its draft. Only sent while journey styles are on.
      ...(isEmailStyleEnabled() && isEmailJourneyStyleEnabled() ? { journeyStyle: { enabled: true } } : {}),
      // Vizzy can read ONE person's situation, without their identity (get_person_brief). Only
      // sent while that is on.
      ...(isPersonBriefEnabled() ? { personBrief: { enabled: true } } : {}),
      // And draft a plan for that person, for staff to approve (save_person_plan).
      ...(isPersonPlansEnabled() ? { personPlans: { enabled: true } } : {}),
    },
  };
}

export async function agentLifecycleJourney(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Promise<ApiResult> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived" || journey.audience?.kind === "waitlist") {
    return { status: 404, body: { error: "not_found" } };
  }
  const connection = await repo.productConnections.getById(journey.connectionId);
  const links = isLifecycleJourneyLinksEnabled();
  const upstream = await upstreamCheck(ctx, journey, journey.draft.settings, db);
  return {
    status: 200,
    body: {
      journey: {
        id: journey.id,
        name: journey.name,
        connectionId: journey.connectionId,
        status: journey.status,
        deliveryMode: journey.deliveryMode,
        publishedVersion: journey.publishedVersion,
        authoredBy: journey.authoredBy,
        draft: journey.draft,
        // Journey links: the journey it starts after, and when its own emails go out.
        ...(links ? { continuesFrom: continuesFromId(journey.draft.settings), timeline: agentTimeline(journey, connection ?? undefined) } : {}),
      },
      issues: connection ? validateLifecycleDraft(journey.draft, connection.catalog, { upstream, dateStart: isLifecycleDateStartEnabled() }).issues : [],
      connection: connection
        ? { id: connection.id, name: connection.name, onboardingSteps: connection.catalog.onboardingSteps.map((s) => ({ id: s.id, label: s.label })) }
        : null,
    },
  };
}
