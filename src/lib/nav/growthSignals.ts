import { readBrandMap } from "@/lib/brandMap/store";
import { forTenant } from "@/lib/tenant";
import { getTenantById } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isMapSaved } from "@/lib/types/brandMap";
import type { Tenant } from "@/lib/types/tenant";
import type { GrowthSignals, SetupSignals } from "./growth";

/**
 * Reads the facts behind the growth path and the Home metrics. Every query is
 * equality-only or a plain list (no new composite indexes) except the 7-day
 * counts, which need the ASC indexes in firestore.indexes.json. Each read fails
 * soft — a missing or still-building index shows "—", never an error page —
 * mirroring the CRM page's per-tab degradation.
 */

async function soft<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[growth] ${label} unavailable:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

const byNewest = <T extends { createdAt?: string | null }>(a: T, b: T) =>
  (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

/** Which optional areas exist in this environment, for the setup guide. */
export interface SetupOptions {
  emailStyle: boolean;
  brandMap: boolean;
}

export async function loadGrowthSignals(
  ctx: TenantContext,
  opts: { lifecycle: boolean; invites?: boolean; setup?: SetupOptions },
  db?: FirestoreLike,
): Promise<GrowthSignals & { lastEventAt: string | null; catalogSteps: number }> {
  const repos = forTenant(ctx, db);
  const setup = opts.setup ? loadSetupSignals(ctx, opts.setup, db) : Promise.resolve(undefined);
  const [campaigns, liveWelcome, liveMovedWelcome, verified, unverified, workspaces, posts, newsletters, connections, journeys, invited] =
    await Promise.all([
      soft("campaigns", repos.campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 100 }), []),
      soft("launch journeys", repos.journeys.count([["status", "==", "active"]]), 0),
      // Launches whose welcome journey moved to the lifecycle engine (engine move).
      soft(
        "moved launch journeys",
        repos.lifecycleJourneys.count([
          ["connectionId", "==", ""],
          ["status", "==", "active"],
        ]),
        0,
      ),
      soft("signups", repos.signups.count([["status", "==", "verified_active"]]), null as number | null),
      soft("signups", repos.signups.count([["status", "==", "unverified"]]), null as number | null),
      soft("workspaces", repos.workspaces.find({ where: [], limit: 200 }), []),
      soft("posts", repos.scheduledPosts.count([["jobKind", "==", "publish"]]), 0),
      soft(
        "newsletters",
        repos.broadcasts.count([
          ["audienceMode", "==", "weekly"],
          ["status", "==", "sent"],
        ]),
        0,
      ),
      opts.lifecycle ? soft("connections", repos.productConnections.find({ limit: 100 }), []) : Promise.resolve([]),
      opts.lifecycle ? soft("journeys", repos.lifecycleJourneys.find({ limit: 100 }), []) : Promise.resolve([]),
      opts.lifecycle && opts.invites
        ? soft("invites", repos.invites.count([["invited", "==", true]]), null as number | null)
        : Promise.resolve(undefined),
    ]);

  const setupSignals = await setup;
  const activeLaunches = campaigns.filter((c) => !c.archivedAt);
  const activeWorkspaces = workspaces.filter((w) => !w.archivedAt).sort(byNewest);
  // Sandboxes ship with a demo catalog and fake events, so only real products count.
  const products = connections.filter((c) => c.kind === "custom" && c.status !== "revoked").sort(byNewest);
  const withEvents = products.filter((c) => !!c.health?.lastEventAt);
  // Product journeys only: a launch's welcome journey on the lifecycle engine doesn't count toward Retain.
  const liveJourneys = journeys.filter((j) => j.status !== "archived" && j.audience?.kind !== "waitlist");
  const newestJourney = [...liveJourneys].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  const lastEventAt = withEvents.map((c) => c.health!.lastEventAt!).sort().at(-1) ?? null;

  return {
    activeLaunches: activeLaunches.length,
    firstLaunchId: activeLaunches[0]?.id ?? null,
    welcomeEmailLive: liveWelcome + liveMovedWelcome > 0,
    signups: verified === null || unverified === null ? null : verified + unverified,
    workspaces: activeWorkspaces.length,
    firstWorkspaceId: activeWorkspaces[0]?.id ?? null,
    postsScheduled: posts,
    newslettersSent: newsletters,
    lifecycle: opts.lifecycle,
    products: products.length,
    firstProductId: (withEvents[0] ?? products[0])?.id ?? null,
    catalogReady: products.some((c) => (c.catalog?.onboardingSteps?.length ?? 0) > 0),
    eventsReceived: withEvents.length > 0,
    journeys: liveJourneys.length,
    firstJourneyId: newestJourney?.id ?? null,
    journeyPublished: liveJourneys.some((j) => j.publishedVersion != null),
    journeyLive: liveJourneys.some((j) => j.status === "active" && j.deliveryMode === "live" && j.publishedVersion != null),
    ...(invited !== undefined ? { invited } : {}),
    ...(setupSignals ? { setup: setupSignals } : {}),
    lastEventAt,
    catalogSteps: products.reduce((n, c) => n + (c.catalog?.onboardingSteps?.length ?? 0), 0),
  };
}

/** The From address is on a verified domain, and the footer's privacy link and postal address are set. */
export function senderDetailsDone(tenant: Pick<Tenant, "emailSenderConfig"> | null): boolean {
  const cfg = tenant?.emailSenderConfig;
  if (!cfg?.fromLocalPart || !cfg.fromDomain || !cfg.privacyPolicyUrl || !cfg.postalAddress?.trim()) return false;
  const from = cfg.fromDomain.toLowerCase();
  return cfg.domains.some((d) => d.status === "verified" && d.domain.toLowerCase() === from);
}

const hasText = (v: string | null | undefined) => !!v?.trim();

/** The setup guide's facts. Each read fails soft to "not done", never an error page. */
async function loadSetupSignals(ctx: TenantContext, opts: SetupOptions, db?: FirestoreLike): Promise<SetupSignals> {
  const repos = forTenant(ctx, db);
  const [tenant, logos, sources, map] = await Promise.all([
    soft("tenant", getTenantById(ctx.tenantId, db), null),
    soft("logos", repos.logos.count(), 0),
    soft("knowledge", repos.ingestionTickets.find({ where: [["ownerKind", "==", "workspace"]], limit: 100 }), []),
    opts.brandMap ? soft("brand map", readBrandMap(ctx, db), { state: "none" as const }) : Promise.resolve(null),
  ]);
  const voice = tenant?.brandVoice;
  return {
    domainVerified: (tenant?.emailSenderConfig?.domains ?? []).some((d) => d.status === "verified"),
    senderDetails: senderDetailsDone(tenant),
    logo: logos > 0,
    voice: !!voice && (hasText(voice.summary) || hasText(voice.guidelines) || (voice.dos?.length ?? 0) > 0),
    emailStyle: opts.emailStyle ? !!tenant?.emailStyle : null,
    knowledge: sources.some((t) => t.status === "done" || t.status === "partial"),
    brandMapSaved: map === null ? null : map.state === "ok" && isMapSaved(map.map),
    social: Object.values(tenant?.socialConnections ?? {}).length > 0,
    git: Object.values(tenant?.gitConnections ?? {}).length > 0,
  };
}

export interface WeekCounts {
  signups: number | null;
  emailsSent: number | null;
  emailsOpened: number | null;
  peopleInJourneys: number | null;
  liveJourneys: number | null;
}

/** Last-7-days counts for the Home tiles (the two ASC indexes back the range counts). */
export async function loadWeekCounts(
  ctx: TenantContext,
  opts: { lifecycle: boolean; now?: Date },
  db?: FirestoreLike,
): Promise<WeekCounts> {
  const repos = forTenant(ctx, db);
  const since = new Date((opts.now ?? new Date()).getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const none = null as number | null;
  const [signups, emailsSent, emailsOpened, peopleInJourneys, liveJourneys] = await Promise.all([
    soft("signups this week", repos.signups.count([["createdAt", ">=", since]]), none),
    soft(
      "emails sent",
      repos.emailEvents.count([
        ["type", "==", "send"],
        ["createdAt", ">=", since],
      ]),
      none,
    ),
    soft(
      "emails opened",
      repos.emailEvents.count([
        ["type", "==", "open"],
        ["createdAt", ">=", since],
      ]),
      none,
    ),
    opts.lifecycle ? soft("enrolments", repos.lifecycleEnrolments.count([["status", "==", "active"]]), none) : none,
    opts.lifecycle
      ? soft(
          "live journeys",
          // Minus launches' welcome journeys (engine move): these tiles are about products.
          Promise.all([
            repos.lifecycleJourneys.count([
              ["status", "==", "active"],
              ["deliveryMode", "==", "live"],
            ]),
            repos.lifecycleJourneys.count([
              ["status", "==", "active"],
              ["deliveryMode", "==", "live"],
              ["connectionId", "==", ""],
            ]),
          ]).then(([all, welcome]) => all - welcome),
          none,
        )
      : none,
  ]);
  return { signups, emailsSent, emailsOpened, peopleInJourneys, liveJourneys };
}
