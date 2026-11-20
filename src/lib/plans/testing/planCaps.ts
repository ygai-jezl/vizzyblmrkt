import type { LimitedFeature } from "../limits";
import { PLANS, type Plan } from "../catalog";

/**
 * Runs `run` with a plan's monthly caps set to `caps`, then puts the plan's own caps back. No plan
 * sets a cap today, so tests use this to keep the plan step of the cap order (brand, plan, copy,
 * default) and the cap lines of the dry runs covered. Tests only.
 */
export async function withPlanCaps<T>(
  id: Plan["id"],
  caps: Partial<Record<LimitedFeature, number>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`no plan ${id}`);
  const own = plan.monthlyCaps;
  (plan as { monthlyCaps: Plan["monthlyCaps"] }).monthlyCaps = caps;
  try {
    return await run();
  } finally {
    (plan as { monthlyCaps: Plan["monthlyCaps"] }).monthlyCaps = own;
  }
}
