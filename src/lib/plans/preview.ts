import type { PlanId } from "@/lib/types/organisation";
import type { Tenant } from "@/lib/types/tenant";
import { FEATURE_NEEDS, METERED_FEATURES, mayReachWith, mayUseWith, type MeteredFeature } from "./brandAccess";
import { FEATURE_LABELS } from "./catalog";
import { LIMITED_FEATURES, monthlyLimitWith, type CapSource, type CapKey, LIMITED_RESOURCES } from "./limits";

/**
 * What would change for a brand if its organisation moved to another plan: the dry run behind
 * scripts/backfill-organisations.ts, set-plan.ts and move-brand.ts. Both sides are worked out
 * with plans on, so a brand with no plan yet shows today's access as "before". A feature counts
 * only when the brand can reach it, with what it needs (FEATURE_NEEDS: the autopilot needs Next
 * up), so a brand granted the autopilot that loses Next up shows it as lost, not kept.
 *
 * It reads GRANTED_ONLY_FEATURES and FEATURE_MONTHLY_LIMITS from the environment, so an operator
 * running a script exports the deployment's own values first.
 */

/**
 * What a brand loses when its plan stops including a feature. Nothing is deleted: the data is
 * kept but hidden, and the scheduled work stops. Each line was checked against the code it
 * describes.
 */
export const EXCLUDED_EFFECT: Record<MeteredFeature, string> = {
  // src/app/admin/brand-kit/competitors/page.tsx (the list), src/lib/competitors/tick.ts (watching)
  competitors: "Saved competitors are kept, but Brand › Competitors shows none and watching them stops.",
  // src/lib/competitors/planningApi.ts, src/lib/competitors/articleTick.ts
  competitor_articles: "Articles already read are kept, and no new competitor articles are read.",
  // src/lib/brandStrategy/finder.ts (findCompetitors asks before every run)
  competitor_finder: "Full competitor finder runs are refused, and a brand that hasn't used its one quick answer can still run it. Competitors already found are kept.",
  // src/lib/search/sweep.ts (the index), src/app/api/agent/search/route.ts (answers not_included)
  brand_search: "The search index stops updating and search answers not included. The index is kept.",
  // src/lib/signals/tick.ts, src/lib/autopilot/tick.ts (the autopilot needs Next up)
  next_up: "No new lookups are made, and the autopilot's scheduled runs stop. Saved lookups are kept.",
  // src/lib/autopilot/adminApi.ts (Draft refused), src/lib/autopilot/draftSteps.ts
  article_autopilot: "Draft runs are refused and the autopilot only suggests. Drafts already written are kept.",
  // src/lib/content/blog/refreshGate.ts (every way a review starts asks there)
  article_refresh: "New refresh reviews are refused. Reviews already made, their proposals and article versions are kept.",
  // src/app/api/admin/editor/vizzy/route.ts
  edit_vizzy: "Vizzy stops editing in Edit mode. Saved content is kept.",
  // src/lib/content/editor/vizzyLearningAccess.ts
  edit_vizzy_learning: "Vizzy stops learning from edits. What it learned is kept.",
  // src/app/admin/welcome/layout.tsx (the welcome), src/app/api/admin/onboarding/voice/start/route.ts
  onboarding_voice: "Talk with Vizzy is hidden on the welcome and in Settings. The 4 quick questions stay, and kept conversations are kept.",
  // src/lib/raise/docs/adminApi.ts (New deck), src/lib/canvas/kinds/raiseDeck.ts (Vizzy's drafts and revises)
  raise_kit: "Vizzy stops drafting decks and New deck is hidden. Decks already made are kept, and you can still edit, present and save them as PDF.",
  // src/lib/i18n/translationsTick.ts (no new translations), src/lib/i18n/emailVersion.ts (sending never asks)
  translations: "No new translations are made, and the language tabs are hidden. Approved translations are kept and still sent.",
};

export interface FeatureChange {
  feature: MeteredFeature;
  before: boolean;
  after: boolean;
  /** For a lost feature: what existing data it hides or what work stops, or what it needs that is lost. */
  hidden?: string;
}

export interface CapChange {
  feature: CapKey;
  before: number;
  after: number;
  beforeFrom: CapSource;
  afterFrom: CapSource;
}

export interface AccessChanges {
  /** Only the features whose access changes. */
  features: FeatureChange[];
  /** Only the caps that change, for features the brand may use on both plans. */
  caps: CapChange[];
  /** A feature is lost or a cap falls. */
  narrower: boolean;
  /** A feature is gained or a cap rises (spend can go up). */
  wider: boolean;
}

type PreviewFields = Pick<Tenant, "grantedFeatures" | "featureLimits" | "orgPlan">;

/** What moving a brand to `nextPlan` (null: no plan, so open) would change. Pure (reads the settings). */
export function accessChanges(tenant: PreviewFields | null, nextPlan: PlanId | null): AccessChanges {
  const before: PreviewFields = { grantedFeatures: tenant?.grantedFeatures, featureLimits: tenant?.featureLimits, orgPlan: tenant?.orgPlan };
  const after: PreviewFields = { ...before, orgPlan: nextPlan ?? undefined };

  const features: FeatureChange[] = [];
  for (const feature of METERED_FEATURES) {
    const was = mayReachWith(before, feature, true);
    const will = mayReachWith(after, feature, true);
    if (was === will) continue;
    // Still in the plan but lost with what it needs: the line for that feature says what stops.
    const needs = FEATURE_NEEDS[feature];
    const hidden = needs && mayUseWith(after, feature, true) ? `It needs ${FEATURE_LABELS[needs]} (${needs}), which is lost too.` : EXCLUDED_EFFECT[feature];
    features.push({ feature, before: was, after: will, ...(was ? { hidden } : {}) });
  }

  const caps: CapChange[] = [];
  for (const feature of LIMITED_FEATURES) {
    // A lost or gained feature is already counted above; its cap matters only while it is usable.
    if (!mayReachWith(before, feature, true) || !mayReachWith(after, feature, true)) continue;
    const was = monthlyLimitWith(before, feature, true);
    const will = monthlyLimitWith(after, feature, true);
    if (was.limit !== will.limit) caps.push({ feature, before: was.limit, after: will.limit, beforeFrom: was.from, afterFrom: will.from });
  }
  // Paid resources are used by every brand, so a cap change always counts.
  for (const resource of LIMITED_RESOURCES) {
    const was = monthlyLimitWith(before, resource, true);
    const will = monthlyLimitWith(after, resource, true);
    if (was.limit !== will.limit) caps.push({ feature: resource, before: was.limit, after: will.limit, beforeFrom: was.from, afterFrom: will.from });
  }

  return {
    features,
    caps,
    narrower: features.some((f) => f.before && !f.after) || caps.some((c) => c.after < c.before),
    wider: features.some((f) => !f.before && f.after) || caps.some((c) => c.after > c.before),
  };
}

const SOURCE: Record<CapSource, string> = { brand: "brand's own cap", plan: "plan's cap", copy: "copy's setting", default: "default" };

/** The changes as lines for a dry run, lost features first. Empty when nothing changes. */
export function accessChangeLines(changes: AccessChanges): string[] {
  const lines: string[] = [];
  for (const f of changes.features.filter((x) => x.before)) lines.push(`loses ${FEATURE_LABELS[f.feature]} (${f.feature}): ${f.hidden ?? ""}`.trim());
  for (const c of changes.caps.filter((x) => x.after < x.before)) lines.push(`${c.feature} cap lowered from ${c.before} to ${c.after} a month (from the ${SOURCE[c.afterFrom]})`);
  for (const f of changes.features.filter((x) => !x.before)) lines.push(`gains ${FEATURE_LABELS[f.feature]} (${f.feature})`);
  for (const c of changes.caps.filter((x) => x.after > x.before)) lines.push(`${c.feature} cap raised from ${c.before} to ${c.after} a month (from the ${SOURCE[c.afterFrom]})`);
  return lines;
}

/**
 * Whether the changes may be applied with the flags given: a change that narrows access (a lost
 * feature, a lower cap) needs --allow-narrower, and one that widens it (a gained feature, a higher
 * cap, so spend can rise) needs --allow-wider. Null when nothing stops it, else why.
 */
export function guardChanges(all: readonly AccessChanges[], allow: { narrower: boolean; wider: boolean }): string | null {
  const reasons: string[] = [];
  if (!allow.narrower && all.some((c) => c.narrower)) reasons.push("Some brands would lose a feature or get a lower cap: pass --allow-narrower to apply.");
  if (!allow.wider && all.some((c) => c.wider)) reasons.push("Some brands would gain a feature or a higher cap, so spend can rise: pass --allow-wider to apply.");
  return reasons.length ? reasons.join(" ") : null;
}

/**
 * The settings a preview read from this shell, for a script to print, so the operator can see
 * they exported the deployment's own values (a preview with other values is wrong).
 */
export function previewSettingsLines(env: Record<string, string | undefined> = process.env): string[] {
  const show = (name: string) => {
    const raw = (env[name] ?? "").trim();
    return `${name}=${raw ? JSON.stringify(raw) : "(unset)"}`;
  };
  return [
    `${show("GRANTED_ONLY_FEATURES")} ${show("FEATURE_MONTHLY_LIMITS")}`,
    "These come from this shell. Export the deployment's own values first, or the preview won't match it.",
  ];
}
