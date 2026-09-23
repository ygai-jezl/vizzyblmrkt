import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { verifyCanvasContext, isCanvasAuthConfigured, tenantContextFromCanvasToken } from "@/lib/canvas/auth";
import { validateLifecycleDraft } from "./graph";
import { isLifecycleChatAuthoringEnabled, isLifecycleEnabled } from "./flags";

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

export async function agentLifecycleContext(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const repo = forTenant(ctx, db);
  const [connections, journeys, workspaces, tenant] = await Promise.all([
    repo.productConnections.find({ limit: 50 }),
    repo.lifecycleJourneys.find({ limit: 100 }),
    repo.workspaces.find({ limit: 50 }).catch(() => []),
    getTenantById(ctx.tenantId, db).catch(() => null),
  ]);
  const live = connections.filter((c) => c.status !== "revoked");
  const withStats = await Promise.all(
    live.map(async (c) => {
      const users = await repo.productUsers.find({ where: [["connectionId", "==", c.id]], limit: MAX_USERS_FOR_STATS });
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        status: c.status,
        catalog: {
          events: c.catalog.events.map((e) => ({ name: e.name, label: e.label, description: e.description })),
          traits: c.catalog.traits.map((t) => ({ key: t.key, type: t.type, label: t.label, description: t.description })),
          onboardingSteps: [...c.catalog.onboardingSteps]
            .sort((a, b) => a.order - b.order)
            .map((s) => ({ id: s.id, label: s.label, url: s.url ?? null, completion: s.completion ?? "" })),
          // What the product can report per user: branch on `fact.<id>`, ground insights in them.
          facts: (c.catalog.facts ?? []).map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit ?? null, description: f.description })),
          glossary: c.catalog.glossary,
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
        .filter((j) => j.status !== "archived")
        .map((j) => ({
          id: j.id,
          name: j.name,
          connectionId: j.connectionId,
          status: j.status,
          deliveryMode: j.deliveryMode,
          publishedVersion: j.publishedVersion,
          authoredBy: j.authoredBy,
          updatedAt: j.updatedAt,
        })),
      verifiedSendingDomains: (tenant?.emailSenderConfig?.domains ?? []).filter((d) => d.status === "verified").map((d) => d.domain),
      senderName: tenant?.emailSenderConfig?.senderName ?? null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: (w as { name?: string }).name ?? w.id })),
    },
  };
}

export async function agentLifecycleJourney(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Promise<ApiResult> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return { status: 404, body: { error: "not_found" } };
  const connection = await repo.productConnections.getById(journey.connectionId);
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
      },
      issues: connection ? validateLifecycleDraft(journey.draft, connection.catalog).issues : [],
      connection: connection
        ? { id: connection.id, name: connection.name, onboardingSteps: connection.catalog.onboardingSteps.map((s) => ({ id: s.id, label: s.label })) }
        : null,
    },
  };
}
