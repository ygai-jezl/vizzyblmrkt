import { createHash } from "node:crypto";
import { listNotes } from "@/lib/brandNotes/store";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import type { AutopilotRun } from "@/lib/types/autopilot";
import { recentRuns } from "./runs";

/**
 * What we've seen, with nobody there: a draft asks the team up to three questions. When every one
 * is answered, the draft gets the answers: if nobody has changed the article since autopilot wrote
 * it, the run goes again from What we've seen (Look again, rewrite, fact check); if someone has,
 * nothing is overwritten and Review says the answers are in, to press Look again.
 */

export interface AnswersDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Done drafts whose team questions are all answered: rewritten, or flagged. Returns how many moved. */
export async function takeAnswers(ctx: TenantContext, deps: AnswersDeps = {}): Promise<number> {
  const waiting = (await recentRuns(ctx, 60, deps)).filter((r) => r.mode === "draft" && r.step === "done" && r.askedIds.length && r.planId && r.workspaceId);
  if (!waiting.length) return 0;
  const notes = new Map((await listNotes(ctx, { db: deps.db })).map((n) => [n.id, n] as const));
  let moved = 0;
  for (const run of waiting) {
    const open = run.askedIds.filter((id) => notes.get(id)?.status === "asked");
    if (open.length === run.askedIds.length) continue;
    if (open.length) {
      // Some answered: keep only the ones still waiting.
      await forTenant(ctx, deps.db).autopilotRuns.update(run.id, { askedIds: open });
      continue;
    }
    moved += await rewriteOrFlag(ctx, run, deps);
  }
  return moved;
}

async function rewriteOrFlag(ctx: TenantContext, run: AutopilotRun, deps: AnswersDeps): Promise<number> {
  const repo = forTenant(ctx, deps.db).autopilotRuns;
  const plan = await getContentPlan(ctx, run.workspaceId!, run.planId!, deps.db);
  const hub = plan?.graph.nodes.find((n) => n.type === "hub");
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const untouched = Boolean(plan && hub && hub.status !== "approved" && plan.autopilot?.runId === run.id && plan.autopilot.state === "done" && hashOf(hub.body) === run.hubHash);
  if (!untouched) {
    await repo.update(run.id, { askedIds: [], answersIn: true, updatedAt: at });
    return 1;
  }
  // Lock it again and go round from What we've seen.
  await updateContentPlan(ctx, run.workspaceId!, run.planId!, { autopilot: { runId: run.id, state: "working", at } }, deps.db);
  await repo.update(run.id, { step: "seen", active: true, askedIds: [], nextAt: at, attempts: 0, error: null, updatedAt: at });
  return 1;
}
