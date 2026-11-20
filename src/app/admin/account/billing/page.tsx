import { requireAdminContext } from "@/lib/auth/session";
import { PlanAndUsage, PlanAndUsageFailed, PlansOff } from "@/components/admin/plans/PlanAndUsage";
import { isPlansEnabled, isPlansUiEnabled } from "@/lib/plans/flags";
import { organisationUsage, type UsageSummary } from "@/lib/plans/usage";

export const dynamic = "force-dynamic";

/**
 * Settings › Plan and usage (the path stays /admin/account/billing). Without
 * NEXT_PUBLIC_PLANS_ENABLED it is today's Billing placeholder, reachable only from the legacy tab
 * list. With the UI switch on and PLANS_ENABLED off it says plans are off (no "coming soon"
 * tabs, as AccountTabs asks). With both on it shows the plan, this brand's figures and, for the
 * organisation's owners, its brands and totals (src/lib/plans/usage.ts decides who sees what).
 */
export default async function AccountBillingPage() {
  const ctx = await requireAdminContext();
  if (!isPlansUiEnabled()) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Billing is coming soon.
      </p>
    );
  }
  if (!isPlansEnabled()) return <PlansOff />;
  let summary: UsageSummary;
  try {
    summary = await organisationUsage(ctx);
  } catch (err) {
    console.warn("[account/billing] plan and usage didn't load", err instanceof Error ? err.message : "unknown error");
    return <PlanAndUsageFailed />;
  }
  return <PlanAndUsage summary={summary} />;
}
