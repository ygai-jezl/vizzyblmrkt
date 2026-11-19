import type { TenantContext } from "@/lib/tenant/types";
import type { FirestoreLike } from "@/lib/tenant/types";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { stopRun } from "./runs";

export type ApiResult = { status: number; body: unknown };

/**
 * A person takes a workflow back from the article autopilot: its run stops (a step under way finds
 * the run stopped and saves nothing more), and the plan's lock lifts so the canvas saves again.
 * Anyone who can edit the workflow may. Works with the autopilot switched off too, so nothing stays
 * locked.
 */
export async function takeOver(ctx: TenantContext, workspaceId: string, planId: string, deps: { db?: FirestoreLike } = {}): Promise<ApiResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{1,64}$/.test(planId)) return { status: 400, body: { error: "invalid_input" } };
  const plan = await getContentPlan(ctx, workspaceId, planId, deps.db);
  if (!plan) return { status: 404, body: { error: "not_found" } };
  if (plan.autopilot?.state !== "working") return { status: 200, body: { ok: true, already: true } };
  await stopRun(ctx, plan.autopilot.runId, "taken_over", deps).catch(() => null);
  await updateContentPlan(ctx, workspaceId, planId, { autopilot: { ...plan.autopilot, state: "stopped", at: new Date().toISOString() } }, deps.db);
  return { status: 200, body: { ok: true } };
}
