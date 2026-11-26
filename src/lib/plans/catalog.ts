import type { MeteredFeature } from "./brandAccess";
import type { CapKey } from "./limits";
import { ENTERPRISE_FEATURES, ENTERPRISE_FEATURE_IDS, type EnterpriseFeature } from "@/lib/enterprise/features";
import { PLAN_IDS, type PlanId } from "@/lib/types/organisation";
import type { Tenant } from "@/lib/types/tenant";
import { isPlansEnabled } from "./flags";

/**
 * The five plans an organisation can be on, kept in code (PLANS_ENABLED). An organisation record
 * names one (organisations/{id}.plan) and each of its brands keeps a copy (tenants.orgPlan).
 *
 * A plan decides three things:
 * - features: which metered features (src/lib/plans/brandAccess.ts) and Enterprise features
 *   (src/lib/enterprise/features.ts) its brands may use. A brand's own grant still adds one, and
 *   GRANTED_ONLY_FEATURES still holds one back (decision 18).
 * - allowances: what the organisation shares across its brands (live launches are per brand).
 *   null means no limit.
 * - monthlyCaps: a per brand cap for a LIMITED_FEATURE or a paid resource, between the brand's
 *   own cap and this copy's FEATURE_MONTHLY_LIMITS (src/lib/plans/limits.ts). Unset: the copy's
 *   cap applies. Free and Pro cap web searches for research (the owner, 2026-11-23); no plan caps
 *   a feature.
 *
 * The numbers follow the signed off tiers table (decision 17), with the article autopilot on
 * Ultra only (the owner, 2026-11-20). Ultra sets no caps, so moving a brand to Ultra changes
 * neither its access nor its spend (decision 20): its web searches follow this copy's cap. Enterprise limits, caps and price are set by
 * agreement: the catalog leaves them open, and a brand's own cap (scripts/grant-feature.ts
 * --limit) carries the agreed number.
 *
 * Pure and client safe (type only imports of the feature unions and the brand), so pages can
 * read it.
 */

/** The Enterprise features, in the order of src/lib/enterprise/features.ts. */
export const EE_FEATURES: readonly EnterpriseFeature[] = ENTERPRISE_FEATURE_IDS;

/** Anything a plan can include. */
export type PlanFeature = MeteredFeature | EnterpriseFeature;

/** What an organisation shares across its brands. */
export const ALLOWANCES = ["brands", "users", "liveIdeas", "people", "emailsPerMonth", "aiCreditsPerMonth"] as const;
export type Allowance = (typeof ALLOWANCES)[number];

/** The allowances counted today. Emails and AI credits wait for their meters ("Not counted yet"). */
export const COUNTED_ALLOWANCES: readonly Allowance[] = ["brands", "users", "liveIdeas", "people"];

/** Allowances that apply to each brand on its own ("Live ideas per brand"); the rest are shared. */
export const PER_BRAND_ALLOWANCES: readonly Allowance[] = ["liveIdeas"];

export interface Plan {
  id: PlanId;
  /** What people read. The screens say "Plan and usage", never a bare "Plan". */
  name: string;
  summary: string;
  /** The summary while launches are called ideas, for a plan whose summary names one. Written out, so help can quote it. */
  summaryAsIdeas?: string;
  /** US dollars per user a month. null: set by agreement. */
  pricePerUserMonthUsd: number | null;
  /** Run by the hosted service, rather than on your own Google Cloud. */
  hosted: boolean;
  features: readonly PlanFeature[];
  /** Shared by the organisation's brands, except PER_BRAND_ALLOWANCES. null means no limit. */
  allowances: Record<Allowance, number | null>;
  /** Allowances given per user: the organisation's limit is the number times its users. */
  perUser: readonly Allowance[];
  /** Per brand, each month. Unset: the copy's cap (FEATURE_MONTHLY_LIMITS), else the default. */
  monthlyCaps: Partial<Record<CapKey, number>>;
  /** Limits and price are agreed per organisation ("Custom" on the tiers table). */
  byAgreement: boolean;
  /** What a plan says in place of a number, for an allowance it leaves to something else. */
  allowanceNotes: Partial<Record<Allowance, string>>;
}

const ALL_METERED: readonly MeteredFeature[] = [
  "edit_vizzy",
  "edit_vizzy_learning",
  "competitors",
  "competitor_articles",
  "competitor_finder",
  "brand_search",
  "next_up",
  "article_autopilot",
  "article_refresh",
  "onboarding_voice",
  "raise_kit",
];

const NO_LIMITS: Record<Allowance, null> = {
  brands: null,
  users: null,
  liveIdeas: null,
  people: null,
  emailsPerMonth: null,
  aiCreditsPerMonth: null,
};

/** The plans in ladder order: Self-hosted, then Free, Pro, Ultra and Enterprise. */
export const PLANS: readonly Plan[] = [
  {
    id: "self_hosted",
    name: "Self-hosted",
    summary: "Your own copy on your Google Cloud. Every open feature, with no limits.",
    pricePerUserMonthUsd: 0,
    hosted: false,
    features: ALL_METERED,
    allowances: NO_LIMITS,
    perUser: [],
    monthlyCaps: {},
    byAgreement: false,
    allowanceNotes: { emailsPerMonth: "Your email provider", aiCreditsPerMonth: "Your own Gemini, no meter" },
  },
  {
    id: "free",
    name: "Free",
    summary: "One brand and one live launch, to try YouGrow with a small team.",
    summaryAsIdeas: "One brand and one live idea, to try YouGrow with a small team.",
    pricePerUserMonthUsd: 0,
    hosted: true,
    // Talk with Vizzy is in every plan (src/lib/plans/brandAccess.ts).
    features: ["onboarding_voice"],
    allowances: { brands: 1, users: 2, liveIdeas: 1, people: 1_000, emailsPerMonth: 1_000, aiCreditsPerMonth: 50 },
    perUser: [],
    monthlyCaps: { web_searches: 300 },
    byAgreement: false,
    allowanceNotes: {},
  },
  {
    // No article autopilot: it drafts the top of Next up, which Pro doesn't have (ADR-0009).
    id: "pro",
    name: "Pro",
    summary: "Up to three brands, with Vizzy in Edit mode and brand search.",
    pricePerUserMonthUsd: 9,
    hosted: true,
    features: ["edit_vizzy", "brand_search", "onboarding_voice"],
    allowances: { brands: 3, users: null, liveIdeas: 5, people: 10_000, emailsPerMonth: 5_000, aiCreditsPerMonth: 250 },
    perUser: ["aiCreditsPerMonth"],
    monthlyCaps: { web_searches: 1_500 },
    byAgreement: false,
    allowanceNotes: {},
  },
  {
    id: "ultra",
    name: "Ultra",
    summary: "Up to ten brands, with Competitors, Next up, the article autopilot and Vizzy learning from your edits.",
    pricePerUserMonthUsd: 35,
    hosted: true,
    features: ALL_METERED,
    allowances: { brands: 10, users: null, liveIdeas: null, people: 100_000, emailsPerMonth: 50_000, aiCreditsPerMonth: 1_200 },
    perUser: ["aiCreditsPerMonth"],
    monthlyCaps: {},
    byAgreement: false,
    allowanceNotes: {},
  },
  {
    id: "enterprise",
    name: "Enterprise",
    summary: "Everything in Ultra plus the Enterprise features, with limits and price agreed with you.",
    pricePerUserMonthUsd: null,
    hosted: true,
    features: [...ALL_METERED, ...ENTERPRISE_FEATURE_IDS],
    allowances: NO_LIMITS,
    perUser: [],
    monthlyCaps: {},
    byAgreement: true,
    allowanceNotes: {},
  },
];

/** What people read for each feature a plan can include. */
export const FEATURE_LABELS: Record<PlanFeature, string> = {
  edit_vizzy: "Vizzy in Edit mode",
  edit_vizzy_learning: "Vizzy learning from edits",
  competitors: "Competitors",
  competitor_articles: "Competitor articles",
  competitor_finder: "Full competitor finder",
  brand_search: "Brand search",
  next_up: "Next up",
  article_autopilot: "Article autopilot",
  article_refresh: "Article refresh reviews",
  onboarding_voice: "Talk with Vizzy by voice",
  raise_kit: "Raise kit",
  ...(Object.fromEntries(ENTERPRISE_FEATURES.map((f) => [f.id, f.label])) as Record<EnterpriseFeature, string>),
};

/**
 * What people read for each allowance. Live ideas reads "Live launches", or "Live ideas" while
 * launches are called ideas (allowanceLabels(isIdeaWordsEnabled())), as the navigation says.
 */
export const ALLOWANCE_LABELS: Record<Allowance, string> = {
  brands: "Brands",
  users: "Users",
  liveIdeas: "Live launches",
  people: "People",
  emailsPerMonth: "Emails a month",
  aiCreditsPerMonth: "AI credits a month",
};

/** The labels while launches are called ideas. Written out, so a help page can quote either. */
export const ALLOWANCE_LABELS_AS_IDEAS: Record<Allowance, string> = { ...ALLOWANCE_LABELS, liveIdeas: "Live ideas" };

/** The allowance labels in the words in use: `ideas` is isIdeaWordsEnabled(). */
export function allowanceLabels(ideas: boolean): Record<Allowance, string> {
  return ideas ? ALLOWANCE_LABELS_AS_IDEAS : ALLOWANCE_LABELS;
}

/** A plan's line in the words in use: Free's "one live launch" is "one live idea" while launches are called ideas. */
export function planSummary(plan: Plan, ideas: boolean): string {
  return ideas ? (plan.summaryAsIdeas ?? plan.summary) : plan.summary;
}

/** The metered and Enterprise features every plan includes, so brand access needs no read for them. */
export const INCLUDED_IN_EVERY_PLAN: readonly PlanFeature[] = PLANS.reduce<readonly PlanFeature[]>(
  (common, plan) => common.filter((f) => plan.features.includes(f)),
  PLANS[0]!.features,
);

/** A plan by its id, or null for anything else (an unknown id never locks anything). */
export function planById(id: unknown): Plan | null {
  if (typeof id !== "string" || !(PLAN_IDS as readonly string[]).includes(id)) return null;
  return PLANS.find((p) => p.id === id) ?? null;
}

/**
 * The plan a brand is on, from its copy of the organisation's plan (tenants.orgPlan). Null when
 * plans are off, the brand has no copy, or the id is unknown: no plan means open, never locked.
 */
export function activePlanOf(tenant: Pick<Tenant, "orgPlan"> | null | undefined, plansOn: boolean = isPlansEnabled()): Plan | null {
  if (!plansOn || !tenant) return null;
  return planById(tenant.orgPlan);
}

/**
 * An organisation's limit for an allowance: the plan's number, times its users for a per user
 * allowance (at least one user). null means no limit.
 */
export function allowanceLimit(plan: Plan, allowance: Allowance, users: number | null = null): number | null {
  const amount = plan.allowances[allowance];
  if (amount === null) return null;
  if (!plan.perUser.includes(allowance)) return amount;
  return amount * Math.max(1, users ?? 1);
}

/** The allowance as the tiers table writes it, for example "1,000", "250 per user" or "No limit". */
export function allowanceText(plan: Plan, allowance: Allowance): string {
  const note = plan.allowanceNotes[allowance];
  if (note) return note;
  const amount = plan.allowances[allowance];
  if (amount === null) return plan.byAgreement ? "Custom" : "No limit";
  const n = amount.toLocaleString("en-US");
  return plan.perUser.includes(allowance) ? `${n} per user` : n;
}

/**
 * The line on the New brand page (PLANS_ENABLED and NEXT_PUBLIC_PLANS_ENABLED): every brand made in
 * the app starts an organisation of its own, on the plan PLANS_NEW_ORGANISATION_PLAN names.
 */
export function newBrandPlanNote(plan: Pick<Plan, "name">): string {
  return `This brand starts on its own plan, ${plan.name}. To put it on one plan with your other brands, ask whoever runs your copy of YouGrow.`;
}
