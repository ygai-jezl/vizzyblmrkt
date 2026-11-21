import { FEATURE_LABELS, allowanceText, planById, type Allowance, type Plan } from "@/lib/plans/catalog";
import type { LimitedFeature } from "@/lib/plans/limits";
import type { AllowanceRow, FeatureRow, MonthlyRow, UsageBrandRow, UsageSummary } from "@/lib/plans/usage";
import type { Region } from "@/lib/types/tenant";
import { peopleArea } from "@/lib/nav/terms";

/**
 * Settings › Plan and usage (PLANS_ENABLED and NEXT_PUBLIC_PLANS_ENABLED), from organisationUsage
 * in src/lib/plans/usage.ts. A server component with no hooks: it only lays out the summary.
 *
 * Who sees what is decided there, not here: the organisation's other brands and its totals are in
 * the summary only for its owners (read live) or a one-brand organisation ("organisation" view).
 * The screens never say a bare "Plan": content plans, person plans and the autopilot already use
 * the word. /help/plan-and-usage explains every line.
 */

/** Every fixed line on the page, so the copy test can check them against the writing rules. */
export const PLAN_AND_USAGE_COPY = {
  plansOff: "Plans are off in this copy of YouGrow, so every brand may use everything its switches turn on.",
  noPlan: "This brand isn't on a plan yet, so everything your copy of YouGrow turns on is open.",
  selfHosted: "Everything is open and nothing is limited.",
  over: "Over your plan. Nobody and nothing is removed, and new ones still come in for now.",
  brandView: "This brand shares a plan with other brands. Their names and totals are shown to the organisation's owners.",
  notIncluded: "Not in your plan. Nothing saved is deleted.",
  notInPlan: "Not in your plan",
  granted: "Granted to this brand",
  heldBack: "Not turned on for this brand yet",
  change: "To change your plan or put brands together on one plan, ask whoever runs your copy of YouGrow.",
  notCounted: "Not counted yet",
  couldNotCount: "Couldn't count",
  users: "Counted once, however many of your brands they are in.",
  month: "Counted from the 1st of each month (UTC).",
  failed: "Plan and usage didn't load. Try again in a moment.",
} as const;

/**
 * What every plan includes, shown before the plan's own features, so Free (which adds none) never
 * reads as a plan with nothing in it. The names the navigation uses: `people` is
 * isPeopleNameEnabled(), so the last one is People or Audience as the sidebar says.
 */
export function everyPlanIncludes(people: boolean): string[] {
  return ["Launches and waitlists", "Journeys", "Posts", peopleArea(people)];
}

const CARD = "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const HINT = "text-xs text-neutral-500 dark:text-neutral-400";
const LABEL = "text-xs font-medium uppercase tracking-wide text-neutral-400";
const PILL = "inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 text-xs dark:border-neutral-800";

const REGION: Record<Region, string> = { us: "United States", eu: "Europe", asia: "Asia" };

/** What each monthly count measures, for "This month". */
const MONTHLY_LABELS: Record<LimitedFeature, string> = {
  next_up: "Google lookups for Next up",
  competitor_articles: "Competitor articles read",
  article_autopilot: "Autopilot drafts",
};

/** Under "This month" the allowances drop their "a month". */
const MONTH_ALLOWANCE_LABELS: Partial<Record<Allowance, string>> = {
  emailsPerMonth: "Emails",
  aiCreditsPerMonth: "AI credits",
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** A feature that works only with another this brand can't use: "Needs Next up". */
export const needsText = (feature: keyof typeof FEATURE_LABELS) => `Needs ${FEATURE_LABELS[feature]}`;

function sinceText(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Since ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
}

/** "4,212 of 10,000", "2, no limit", "5,000 or more of 5,000". */
function usedText(used: number, limit: number | null, capped = false): string {
  const u = capped ? `${fmt(used)} or more` : fmt(used);
  return limit === null ? `${u}, no limit` : `${u} of ${fmt(limit)}`;
}

function Meter({ label, value, used, limit, note }: { label: string; value: string; used?: number | null; limit?: number | null; note?: string | null }) {
  const pct = typeof used === "number" && typeof limit === "number" && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-3 text-sm tabular-nums">
        <span>{label}</span>
        <span className="shrink-0 text-right text-neutral-500 dark:text-neutral-400">{value}</span>
      </div>
      {pct !== null ? (
        <div aria-hidden className="h-1.5 overflow-hidden rounded-full border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900">
          <div className={`h-full rounded-full ${pct >= 90 ? "bg-amber-500" : "bg-blue-600 dark:bg-blue-500"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {note ? <p className={HINT}>{note}</p> : null}
    </div>
  );
}

/** A counted allowance: "N of M", or "Not counted yet" with what the plan gives. */
function AllowanceMeter({ row, plan, label }: { row: AllowanceRow; plan: Plan | null; label: string }) {
  if (!row.counted) {
    let note: string | null = null;
    if (row.limit !== null) note = row.perUser && plan ? `${fmt(row.limit)} a month, ${allowanceText(plan, row.key)}` : `${fmt(row.limit)} a month`;
    else if (plan) note = allowanceText(plan, row.key);
    return <Meter label={label} value={PLAN_AND_USAGE_COPY.notCounted} note={note} />;
  }
  if (row.used === null) return <Meter label={label} value={PLAN_AND_USAGE_COPY.couldNotCount} />;
  return (
    <Meter
      label={label}
      value={usedText(row.used, row.limit, row.capped)}
      used={row.used}
      limit={row.limit}
      note={row.key === "users" ? PLAN_AND_USAGE_COPY.users : null}
    />
  );
}

function MonthlyMeter({ row }: { row: MonthlyRow }) {
  const label = MONTHLY_LABELS[row.feature];
  if (!row.included) return <Meter label={label} value={row.needs ? needsText(row.needs) : PLAN_AND_USAGE_COPY.notInPlan} />;
  if (row.used === null) return <Meter label={label} value={PLAN_AND_USAGE_COPY.couldNotCount} />;
  return <Meter label={label} value={usedText(row.used, row.limit)} used={row.used} limit={row.limit} />;
}

function BrandPill({ brand }: { brand: UsageBrandRow }) {
  return (
    <li className={PILL}>
      <span className="font-medium">{brand.name}</span>
      <span className="text-neutral-500 dark:text-neutral-400">{REGION[brand.region] ?? brand.region}</span>
      {brand.isThis ? <span className="rounded bg-blue-50 px-1 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">This brand</span> : null}
      {brand.status === "suspended" ? (
        <span className="rounded bg-amber-50 px-1 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">Suspended</span>
      ) : null}
    </li>
  );
}

function FeaturePill({ row }: { row: FeatureRow }) {
  const note = row.usable ? (row.included ? null : PLAN_AND_USAGE_COPY.granted) : row.needs ? needsText(row.needs) : PLAN_AND_USAGE_COPY.heldBack;
  return (
    <li className={`${PILL} ${row.usable ? "" : "text-neutral-500 dark:text-neutral-400"}`}>
      {row.label}
      {note ? <span className="text-neutral-500 dark:text-neutral-400">· {note}</span> : null}
    </li>
  );
}

/** With NEXT_PUBLIC_PLANS_ENABLED on and PLANS_ENABLED off: a neutral line, never "coming soon". */
export function PlansOff() {
  return <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-300">{PLAN_AND_USAGE_COPY.plansOff}</p>;
}

/** organisationUsage threw (the brand record didn't load). */
export function PlanAndUsageFailed() {
  return <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-300">{PLAN_AND_USAGE_COPY.failed}</p>;
}

export function PlanAndUsage({ summary, people = false }: { summary: UsageSummary; people?: boolean }) {
  const plan = planById(summary.plan);
  const org = summary.organisation;
  const orgView = org?.view === "organisation";
  const since = plan && org && org.plan === plan.id ? sinceText(org.planSince) : null;

  // A feature the plan leaves out (and no grant adds) is listed apart; the rest are pills. One
  // granted without what it needs (the autopilot without Next up) is a pill that says so.
  const shown = summary.features.filter((f) => f.usable || f.included || f.granted);
  const left = summary.features.filter((f) => !f.usable && !f.included && !f.granted);

  const brand = summary.thisBrand;
  const liveOver = brand.liveLaunches !== null && brand.liveLaunchesLimit !== null && brand.liveLaunches > brand.liveLaunchesLimit;
  const orgNow = orgView ? (summary.allowances ?? []).filter((a) => a.counted && a.scope === "organisation") : [];
  const orgMonth = orgView ? (summary.allowances ?? []).filter((a) => !a.counted) : [];
  const orgOver = orgView && (summary.allowances ?? []).some((a) => a.over && a.scope === "organisation");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
        <section aria-labelledby="your-plan" className={`${CARD} space-y-3 self-start`}>
          <div className="space-y-1">
            <h2 id="your-plan" className="text-sm font-semibold">
              Your plan
            </h2>
            {/* Only in organisation view: the name is often another brand's (decision 21). */}
            {orgView && org?.name ? <p className={HINT}>{org.name}</p> : null}
            {plan ? <p className="text-2xl font-semibold">{plan.name}</p> : null}
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {!plan ? PLAN_AND_USAGE_COPY.noPlan : plan.id === "self_hosted" ? PLAN_AND_USAGE_COPY.selfHosted : plan.summary}
            </p>
            {since ? <p className={HINT}>{since}</p> : null}
          </div>

          {orgView && summary.brands ? (
            <div className="space-y-1.5">
              <h3 className={LABEL}>Brands on this plan</h3>
              <ul className="flex flex-wrap gap-1.5">
                {summary.brands.map((b) => (
                  <BrandPill key={b.id} brand={b} />
                ))}
              </ul>
            </div>
          ) : org ? (
            <p className={HINT}>{PLAN_AND_USAGE_COPY.brandView}</p>
          ) : null}

          <div className="space-y-1.5">
            <h3 className={LABEL}>{plan ? "What your plan includes" : "What this brand can use"}</h3>
            <ul className="flex flex-wrap gap-1.5">
              {everyPlanIncludes(people).map((name) => (
                <li key={name} className={PILL}>
                  {name}
                </li>
              ))}
              {shown.map((f) => (
                <FeaturePill key={f.feature} row={f} />
              ))}
            </ul>
            {left.length ? (
              <div className="space-y-1.5 pt-1">
                <p className={HINT}>{PLAN_AND_USAGE_COPY.notIncluded}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {left.map((f) => (
                    <li key={f.feature} className={`${PILL} border-dashed text-neutral-500 dark:text-neutral-400`}>
                      {f.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>

        <div className="space-y-4">
          {orgView ? (
            <section aria-labelledby="your-organisation" className={`${CARD} space-y-4`}>
              <h2 id="your-organisation" className="text-sm font-semibold">
                Your organisation
              </h2>
              <div className="space-y-3">
                <h3 className={LABEL}>Now</h3>
                {orgNow.map((row) => (
                  <AllowanceMeter key={row.key} row={row} plan={plan} label={row.label} />
                ))}
              </div>
              {orgMonth.length ? (
                <div className="space-y-3">
                  <h3 className={LABEL}>This month</h3>
                  {orgMonth.map((row) => (
                    <AllowanceMeter key={row.key} row={row} plan={plan} label={MONTH_ALLOWANCE_LABELS[row.key] ?? row.label} />
                  ))}
                </div>
              ) : null}
              {orgOver ? <p className="text-sm text-amber-800 dark:text-amber-300">{PLAN_AND_USAGE_COPY.over}</p> : null}
            </section>
          ) : null}

          <section aria-labelledby="this-brand" className={`${CARD} space-y-4`}>
            <h2 id="this-brand" className="text-sm font-semibold">
              This brand · {brand.name}
            </h2>
            <div className="space-y-3">
              <h3 className={LABEL}>Now</h3>
              <Meter label="People" value={brand.people === null ? PLAN_AND_USAGE_COPY.couldNotCount : fmt(brand.people)} />
              <Meter
                label="Live launches"
                value={
                  brand.liveLaunches === null
                    ? PLAN_AND_USAGE_COPY.couldNotCount
                    : brand.liveLaunchesLimit === null && !plan
                      ? brand.liveLaunchesCapped
                        ? `${fmt(brand.liveLaunches)} or more`
                        : fmt(brand.liveLaunches)
                      : usedText(brand.liveLaunches, brand.liveLaunchesLimit, brand.liveLaunchesCapped)
                }
                used={brand.liveLaunches}
                limit={brand.liveLaunchesLimit}
              />
              {liveOver ? <p className="text-sm text-amber-800 dark:text-amber-300">{PLAN_AND_USAGE_COPY.over}</p> : null}
            </div>
            {summary.monthly.length ? (
              <div className="space-y-3">
                <h3 className={LABEL}>This month</h3>
                {summary.monthly.map((row) => (
                  <MonthlyMeter key={row.feature} row={row} />
                ))}
                <p className={HINT}>{PLAN_AND_USAGE_COPY.month}</p>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <section aria-labelledby="how-to-change" className="max-w-2xl space-y-1">
        <h2 id="how-to-change" className="text-sm font-semibold">
          How to change
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{PLAN_AND_USAGE_COPY.change}</p>
      </section>
    </div>
  );
}
