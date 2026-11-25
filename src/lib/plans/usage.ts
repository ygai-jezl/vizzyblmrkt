import { countLiveLaunches, forTenant, getOrganisation, getTenantById, organisationUserIds } from "@/lib/tenant";
import type { FirestoreLike, TenantContext, WhereOp } from "@/lib/tenant/types";
import type { Organisation, PlanId } from "@/lib/types/organisation";
import type { Region, Tenant, TenantStatus } from "@/lib/types/tenant";
import { isPersonLinksEnabled } from "@/lib/audience/flags";
import { isAutopilotEnabled, isNextUpEnabled } from "@/lib/autopilot/flags";
import { draftsThisMonth } from "@/lib/autopilot/runs";
import { isCompetitorArticlesEnabled } from "@/lib/competitors/flags";
import { readsThisMonth } from "@/lib/competitors/articles";
import { lookupsThisMonth } from "@/lib/signals/store";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { reviewsThisMonth } from "@/lib/content/blog/refreshRecords";
import { FEATURE_NEEDS, METERED_FEATURES, mayReachWith, mayUseWith, type MeteredFeature } from "./brandAccess";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import {
  ALLOWANCES,
  allowanceLabels,
  COUNTED_ALLOWANCES,
  EE_FEATURES,
  FEATURE_LABELS,
  PER_BRAND_ALLOWANCES,
  activePlanOf,
  allowanceLimit,
  planById,
  type Allowance,
  type Plan,
  type PlanFeature,
} from "./catalog";
import { isPlansEnabled } from "./flags";
import { isLimitedResource, monthlyLimitWith, type CapKey, type CapSource, type LimitedFeature } from "./limits";
import { addCounts, usageThisMonth } from "./meter";
import type { ResourceCount } from "@/lib/types/usageMeter";
import { RESOURCE_IDS, RESOURCES, type ResourceId } from "./resources";
import { isUsageMeterEnabled } from "./flags";
import { isOnboardingVoiceEnabled } from "@/lib/onboarding/flags";

/**
 * Talk with Vizzy by voice is in every plan, but only offered where ONBOARDING_VOICE_ENABLED is on:
 * off, Plan and usage doesn't list it, and its seconds show only when some were counted this month
 * (it was on earlier in the month).
 */
const voiceShown = (used: number | null | undefined) => isOnboardingVoiceEnabled() || (used ?? 0) > 0;
const VOICE_RESOURCE: ResourceId = "voice_seconds";

/**
 * The figures behind Settings › Plan and usage, and allowance counting for later pieces. Server
 * only.
 *
 * Who sees what (decision 21): this brand's own figures go to anyone in the brand. The
 * organisation's name and id, its other brands and its totals go only to the people in its
 * `ownerIds`, read live from the organisation record on every view (never from the session's role
 * claim), or to anyone when the organisation holds only this brand. Otherwise no other brand is
 * read at all, and only the plan and since when reach the summary. Owners see only brands whose
 * own record points back at the organisation.
 *
 * Another brand is read through a system context built from its registry record (tenantId and
 * region, both from the server), as src/app/api/webhooks/mailchimp/route.ts does. Only counts are
 * read, never people's rows, and nothing is copied into the control database.
 *
 * Read budget for one view in organisation view, per brand: 1 registry read, 1 people count (1
 * read per 1000 index entries), 1 read per launch (up to 5000) and its tenant_users rows. Brand
 * view reads only this brand.
 */

export interface UsageDeps {
  /** The control database ((default)): brands, organisations and memberships. */
  db?: FirestoreLike;
  /** A brand's own data, by its region. Unset: that region's database. */
  dataDb?: FirestoreLike | ((region: Region) => FirestoreLike);
  loadTenant?: (id: string) => Promise<Tenant | null>;
  now?: () => Date;
}

export interface BrandFigures {
  /** null: couldn't count. */
  people: number | null;
  liveLaunches: number | null;
  /** More launches than were read: the count is a floor ("5000 or more"). */
  liveLaunchesCapped: boolean;
}

export interface UsageBrandRow extends BrandFigures {
  id: string;
  name: string;
  region: Region;
  /** Suspended brands still count towards the brands allowance, marked Suspended. */
  status: TenantStatus;
  isThis: boolean;
}

export interface AllowanceRow {
  key: Allowance;
  label: string;
  /** null: not counted yet, or couldn't count. */
  used: number | null;
  /** null: no limit. */
  limit: number | null;
  /** false for emails and AI credits until their meters exist ("Not counted yet"). */
  counted: boolean;
  /** "brand" for live launches, which are per brand (this brand's figure); else shared. */
  scope: "organisation" | "brand";
  /** The limit is the plan's number times the organisation's users. */
  perUser: boolean;
  /** `used` is a floor. */
  capped: boolean;
  /**
   * Over the plan. Nobody and nothing is removed, and nothing new is stopped yet: in A only
   * move-brand enforces the brands allowance. Later pieces enforce the others.
   */
  over: boolean;
}

export interface MonthlyRow {
  /** A costly feature, or a paid resource (src/lib/plans/resources.ts). */
  feature: CapKey | ResourceId;
  label: string;
  used: number | null;
  /** Null: counted, with no limit (AI model use). */
  limit: number | null;
  from: CapSource | null;
  /** Whether this brand can use the feature at all, with what it needs. */
  included: boolean;
  /** What it needs and this brand can't use ("Needs Next up"); null otherwise. */
  needs: MeteredFeature | null;
  /** A resource: what used it this month, by feature (RESOURCES[...].purposes). */
  byPurpose?: Record<string, number>;
  /** AI model use: tokens by model. */
  byModel?: Record<string, number>;
  /** The unit it counts in ("searches", "tokens", "images"), for a resource. */
  unit?: string;
}

/** An organisation's use of a paid resource this month, all its brands added up. */
export interface OrganisationResourceRow {
  resource: ResourceId;
  label: string;
  unit: string;
  /** Null when a brand couldn't be read: never shown low. */
  used: number | null;
}

export interface FeatureRow {
  feature: PlanFeature;
  label: string;
  /** The plan includes it (with no plan, everything is open). */
  included: boolean;
  /** This brand has its own grant for it. */
  granted: boolean;
  /** What brand access answers, with grants and GRANTED_ONLY_FEATURES applied, and what it needs. */
  usable: boolean;
  /** What it needs and this brand can't use ("Needs Next up"); null otherwise. */
  needs: MeteredFeature | null;
}

export interface UsageSummary {
  /** The calendar month counted, UTC (YYYY-MM). */
  month: string;
  plansOn: boolean;
  /** The plan in force for this brand (its copy of the organisation's plan); null: open. */
  plan: PlanId | null;
  thisBrand: { id: string; name: string; region: Region; status: TenantStatus; liveLaunchesLimit: number | null } & BrandFigures;
  organisation: {
    /**
     * Organisation view only (null in brand view). An organisation is named after the brand it was
     * made for, and its id is org_<that brand's id>, so either could name another brand (decision 21).
     */
    id: string | null;
    name: string | null;
    plan: PlanId;
    planSince: string;
    /** The viewer is one of its owners (read live). */
    owner: boolean;
    view: "organisation" | "brand";
  } | null;
  /** Organisation view only. */
  brands: UsageBrandRow[] | null;
  /** Organisation view only, with the usage meter on: each paid resource's total this month. */
  organisationResources?: OrganisationResourceRow[];
  /** Organisation view only. */
  allowances: AllowanceRow[] | null;
  /** This brand only, and only for features whose switch is on. */
  monthly: MonthlyRow[];
  features: FeatureRow[];
}

const loaderOf = (deps: UsageDeps) => deps.loadTenant ?? ((id: string) => getTenantById(id, deps.db));
const dataDbFor = (deps: UsageDeps, region: Region) => (typeof deps.dataDb === "function" ? deps.dataDb(region) : deps.dataDb);

/** A count that may fail: null instead of a throw, so one failure shows "Couldn't count". */
async function soft<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.warn("[plans/usage] a count failed", err instanceof Error ? err.message : "unknown error");
    return null;
  }
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The people filter Audience uses: the "all" tag with person links on, every contact otherwise. */
function peopleWhere(): Array<[string, WhereOp, unknown]> {
  return isPersonLinksEnabled() ? [["memberOf", "array-contains", "all"]] : [];
}

/** One brand's counts, through a context whose brand and region come from the server. */
async function brandFigures(ctx: Pick<TenantContext, "tenantId" | "region">, deps: UsageDeps): Promise<BrandFigures> {
  const sys: TenantContext = { tenantId: ctx.tenantId, region: ctx.region, source: "system" };
  const db = dataDbFor(deps, ctx.region);
  const [people, live] = await Promise.all([
    soft(() => forTenant(sys, db).contacts.count(peopleWhere())),
    soft(() => countLiveLaunches(sys, {}, db)),
  ]);
  return { people, liveLaunches: live?.count ?? null, liveLaunchesCapped: live?.capped ?? false };
}

function sumOf(values: Array<number | null>): number | null {
  return values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** What a feature this brand may use still needs and can't use: a granted autopilot without Next up. */
function missingNeed(tenant: Tenant | null, feature: MeteredFeature, plansOn: boolean): MeteredFeature | null {
  const needs = FEATURE_NEEDS[feature];
  return needs && mayUseWith(tenant, feature, plansOn) && !mayReachWith(tenant, needs, plansOn) ? needs : null;
}

async function monthlyRows(ctx: TenantContext, tenant: Tenant | null, plansOn: boolean, deps: UsageDeps, now: Date): Promise<MonthlyRow[]> {
  const counters = { db: dataDbFor(deps, ctx.region), now: () => now };
  const rows: Array<{ feature: LimitedFeature; on: boolean; count: () => Promise<number> }> = [
    { feature: "next_up", on: isNextUpEnabled(), count: () => lookupsThisMonth(ctx, counters) },
    { feature: "competitor_articles", on: isCompetitorArticlesEnabled(), count: () => readsThisMonth(ctx, counters) },
    { feature: "article_autopilot", on: isAutopilotEnabled(), count: () => draftsThisMonth(ctx, counters) },
    { feature: "article_refresh", on: isBlogRefreshEnabled(), count: () => reviewsThisMonth(ctx, counters) },
  ];
  const features = Promise.all(
    rows
      .filter((r) => r.on)
      .map(async (r): Promise<MonthlyRow> => {
        const cap = monthlyLimitWith(tenant, r.feature, plansOn);
        return {
          feature: r.feature,
          label: FEATURE_LABELS[r.feature],
          used: await soft(r.count),
          limit: cap.limit,
          from: cap.from,
          included: mayReachWith(tenant, r.feature, plansOn),
          needs: missingNeed(tenant, r.feature, plansOn),
        };
      }),
  );
  // Paid resources: every brand uses them, through the features that spend them (the usage meter).
  if (!isUsageMeterEnabled()) return features;
  const meters = await soft(() => usageThisMonth(ctx, counters));
  const shown = await features;
  // The older counters keep their own rows (their caps count records); the meter adds what used them.
  for (const r of RESOURCE_IDS) {
    const on = RESOURCES[r].shownAs;
    const row = on ? shown.find((f) => f.feature === on) : undefined;
    const count = meters?.[r];
    if (row && count) row.byPurpose = count.byPurpose ?? {};
  }
  const resources = RESOURCE_IDS.filter((r) => RESOURCES[r].shownAs === null && (r !== VOICE_RESOURCE || voiceShown(meters?.[r]?.total))).map((r): MonthlyRow => {
    const count = meters === null ? null : (meters[r] ?? null);
    const cap = isLimitedResource(r) ? monthlyLimitWith(tenant, r, plansOn) : null;
    return {
      feature: r,
      label: RESOURCES[r].label,
      used: meters === null ? null : (count?.total ?? 0),
      limit: cap?.limit ?? null,
      from: cap?.from ?? null,
      included: true,
      needs: null,
      unit: RESOURCES[r].unit,
      byPurpose: count?.byPurpose ?? {},
      ...(count?.byModel ? { byModel: count.byModel } : {}),
    };
  });
  return [...shown, ...resources];
}

/** Each paid resource's organisation total this month (the meter on): null where a brand couldn't be read. */
async function organisationResources(brands: Array<{ id: string; region: Region }>, deps: UsageDeps, now: Date): Promise<OrganisationResourceRow[]> {
  // Each brand read in its own region (by id); one that can't be read makes the totals unknown.
  const each = await Promise.all(brands.map((b) => usageThisMonth({ tenantId: b.id, region: b.region }, { db: dataDbFor(deps, b.region), now: () => now }).catch(() => null)));
  const totals = each.some((m) => m === null) ? null : each.reduce<Partial<Record<ResourceId, ResourceCount>>>((sum, m) => {
    for (const [r, c] of Object.entries(m!) as Array<[ResourceId, ResourceCount]>) sum[r] = addCounts(sum[r] ?? { total: 0, calls: 0, lostCalls: 0, byPurpose: {} }, c);
    return sum;
  }, {});
  return RESOURCE_IDS.filter((r) => RESOURCES[r].shownAs === null && (r !== VOICE_RESOURCE || voiceShown(totals?.[r]?.total))).map((r) => ({
    resource: r,
    label: RESOURCES[r].label,
    unit: RESOURCES[r].unit,
    used: totals === null ? null : (totals[r]?.total ?? 0),
  }));
}

function featureRows(tenant: Tenant | null, plan: Plan | null, plansOn: boolean): FeatureRow[] {
  const ee = EE_FEATURES.filter((f) => plan?.features.includes(f));
  const metered = METERED_FEATURES.filter((f) => f !== "onboarding_voice" || voiceShown(0));
  return [...metered, ...ee].map((feature) => {
    const included = plan ? plan.features.includes(feature) : true;
    const metered = (METERED_FEATURES as readonly string[]).includes(feature) ? (feature as MeteredFeature) : null;
    return {
      feature,
      label: FEATURE_LABELS[feature],
      included,
      granted: Boolean(tenant?.grantedFeatures?.includes(feature)),
      usable: metered ? mayReachWith(tenant, metered, plansOn) : included,
      needs: metered ? missingNeed(tenant, metered, plansOn) : null,
    };
  });
}

function allowanceRow(key: Allowance, plan: Plan | null, used: number | null, users: number | null, capped = false): AllowanceRow {
  const counted = COUNTED_ALLOWANCES.includes(key);
  const limit = plan ? allowanceLimit(plan, key, users) : null;
  const value = counted ? used : null;
  return {
    key,
    label: allowanceLabels(isIdeaWordsEnabled())[key],
    used: value,
    limit,
    counted,
    scope: PER_BRAND_ALLOWANCES.includes(key) ? "brand" : "organisation",
    perUser: plan?.perUser.includes(key) ?? false,
    capped: counted && capped,
    over: value !== null && limit !== null && value > limit,
  };
}

/** Everything Plan and usage shows for the signed-in brand and viewer. */
export async function organisationUsage(ctx: TenantContext, deps: UsageDeps = {}): Promise<UsageSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const plansOn = isPlansEnabled();
  const load = loaderOf(deps);
  const tenant = await load(ctx.tenantId);
  const plan = activePlanOf(tenant, plansOn);
  const [mine, monthly] = await Promise.all([brandFigures(ctx, deps), monthlyRows(ctx, tenant, plansOn, deps, now)]);
  const thisBrand = {
    id: ctx.tenantId,
    name: tenant?.tenantName ?? ctx.tenantId,
    region: ctx.region,
    status: tenant?.status ?? "active",
    liveLaunchesLimit: plan ? allowanceLimit(plan, "liveIdeas") : null,
    ...mine,
  };
  const summary: UsageSummary = {
    month: monthOf(now),
    plansOn,
    plan: plan?.id ?? null,
    thisBrand,
    organisation: null,
    brands: null,
    allowances: null,
    monthly,
    features: featureRows(tenant, plan, plansOn),
  };
  if (!plansOn || !tenant?.organisationId) return summary;

  const org = await soft(() => getOrganisation(tenant.organisationId!, deps.db));
  // An organisation that doesn't list this brand is drift (--check reports it): show none.
  if (!org || !org.brandIds.includes(ctx.tenantId)) return summary;
  const owner = Boolean(ctx.userId && org.ownerIds.includes(ctx.userId));
  const view = owner || org.brandIds.length === 1 ? "organisation" : "brand";
  if (view === "brand") {
    summary.organisation = { id: null, name: null, plan: org.plan, planSince: org.planSince, owner, view };
    return summary;
  }
  summary.organisation = { id: org.id, name: org.name, plan: org.plan, planSince: org.planSince, owner, view };

  const thisRow: UsageBrandRow = { id: ctx.tenantId, name: thisBrand.name, region: ctx.region, status: thisBrand.status, isThis: true, ...mine };
  const [siblings, users] = await Promise.all([
    mapLimit(
      org.brandIds.filter((id) => id !== ctx.tenantId),
      5,
      async (id): Promise<UsageBrandRow | null> => {
        const t = await soft(() => load(id));
        // A listed brand whose own record points at another organisation (or none) is drift, which
        // --check reports: it is neither shown nor counted, so its owners' data stays theirs.
        if (!t || t.organisationId !== org.id) return null;
        return { id, name: t.tenantName, region: t.region, status: t.status, isThis: false, ...(await brandFigures({ tenantId: id, region: t.region }, deps)) };
      },
    ),
    soft(async () => (await organisationUserIds(org, deps.db)).size),
  ]);
  const byId = new Map(siblings.filter((r): r is UsageBrandRow => r !== null).map((r) => [r.id, r]));
  summary.brands = org.brandIds.map((id) => (id === ctx.tenantId ? thisRow : byId.get(id))).filter((r): r is UsageBrandRow => Boolean(r));
  if (isUsageMeterEnabled()) {
    // A listed brand that couldn't be shown counts as unread: the totals say "Couldn't count".
    const missing = summary.brands.length < org.brandIds.length;
    const rows = await organisationResources(summary.brands, deps, now);
    summary.organisationResources = missing ? rows.map((r) => ({ ...r, used: null })) : rows;
  }
  const orgPlan = planById(org.plan);
  const people = sumOf(summary.brands.map((b) => b.people).concat(summary.brands.length < org.brandIds.length ? [null] : []));
  summary.allowances = ALLOWANCES.map((key) => {
    switch (key) {
      case "brands":
        return allowanceRow(key, orgPlan, org.brandIds.length, users);
      case "users":
        return allowanceRow(key, orgPlan, users, users);
      case "people":
        return allowanceRow(key, orgPlan, people, users);
      case "liveIdeas":
        return allowanceRow(key, orgPlan, mine.liveLaunches, users, mine.liveLaunchesCapped);
      default:
        return allowanceRow(key, orgPlan, null, users);
    }
  });
  return summary;
}

export interface AllowanceUse {
  /** null: not counted yet, or couldn't count. */
  used: number | null;
  /** null: no limit. */
  limit: number | null;
  counted: boolean;
}

/**
 * How much of one allowance an organisation uses, against its plan. Live launches are per brand,
 * so they need the brand (`brand`); without it they read as not counted.
 */
export async function organisationAllowance(
  org: Pick<Organisation, "plan" | "brandIds">,
  allowance: Allowance,
  deps: UsageDeps = {},
  brand?: Pick<TenantContext, "tenantId" | "region">,
): Promise<AllowanceUse> {
  const plan = planById(org.plan);
  const needsUsers = allowance === "users" || Boolean(plan?.perUser.includes(allowance));
  const users = needsUsers ? await soft(async () => (await organisationUserIds(org, deps.db)).size) : null;
  const limit = plan ? allowanceLimit(plan, allowance, users) : null;
  if (!COUNTED_ALLOWANCES.includes(allowance)) return { used: null, limit, counted: false };
  switch (allowance) {
    case "brands":
      return { used: org.brandIds.length, limit, counted: true };
    case "users":
      return { used: users, limit, counted: true };
    case "liveIdeas": {
      if (!brand) return { used: null, limit, counted: false };
      const live = await soft(() => countLiveLaunches(brand, {}, dataDbFor(deps, brand.region)));
      return { used: live?.count ?? null, limit, counted: true };
    }
    default: {
      const load = loaderOf(deps);
      const counts = await mapLimit(org.brandIds, 5, async (id) => {
        const t = await soft(() => load(id));
        return t ? (await brandFigures({ tenantId: id, region: t.region }, deps)).people : null;
      });
      return { used: sumOf(counts), limit, counted: true };
    }
  }
}

/**
 * Whether the signed-in brand's organisation has room for `adding` more of an allowance. Ready
 * for later pieces (people, live ideas, users); nothing in the app calls it yet. Allowed when
 * plans are off, the brand has no organisation, the allowance isn't counted, the limit is none,
 * or the count fails: a check never locks anyone out by mistake.
 */
export async function checkAllowance(
  ctx: TenantContext,
  allowance: Allowance,
  adding = 1,
  deps: UsageDeps = {},
): Promise<{ allowed: boolean; used: number | null; limit: number | null; organisationId: string | null }> {
  const open = (organisationId: string | null = null, used: number | null = null, limit: number | null = null) => ({ allowed: true, used, limit, organisationId });
  if (!isPlansEnabled() || !COUNTED_ALLOWANCES.includes(allowance)) return open();
  const tenant = await soft(() => loaderOf(deps)(ctx.tenantId));
  if (!tenant?.organisationId) return open();
  const org = await soft(() => getOrganisation(tenant.organisationId!, deps.db));
  if (!org) return open();
  const use = await organisationAllowance(org, allowance, deps, { tenantId: ctx.tenantId, region: ctx.region });
  if (use.limit === null || use.used === null) return open(org.id, use.used, use.limit);
  return { allowed: use.used + adding <= use.limit, used: use.used, limit: use.limit, organisationId: org.id };
}

/**
 * Whether a person may join the organisation under its plan's users allowance: someone already
 * in it always may, and a plan with no users limit always has room. Pure; for piece M's invites.
 * `plan` defaults to the organisation's own.
 */
export function mayAddUser(
  org: Pick<Organisation, "plan">,
  plan: Plan | null,
  userId: string,
  currentIds: ReadonlySet<string>,
): boolean {
  if (currentIds.has(userId)) return true;
  const p = plan ?? planById(org.plan);
  const limit = p ? allowanceLimit(p, "users") : null;
  return limit === null || currentIds.size < limit;
}
