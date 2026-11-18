import type { ContentPlan } from "@/lib/types/contentPlan";

/**
 * Whether the article autopilot is writing a plan right now (plan.autopilot.state "working"). The
 * plan's edit routes refuse with 409 `autopilot_running` meanwhile, so a canvas opened earlier can't
 * save its older copy over the run's work, and the run never writes over a person's. A person can
 * take over, which stops the run. Pure.
 */
export function autopilotHolds(plan: Pick<ContentPlan, "autopilot"> | null | undefined): boolean {
  return plan?.autopilot?.state === "working";
}

export const AUTOPILOT_RUNNING = { error: "autopilot_running" } as const;
