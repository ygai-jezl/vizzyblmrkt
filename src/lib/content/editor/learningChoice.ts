import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { isMemoryBankConfigured, listEditMemories } from "@/lib/agents/memoryBank";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { brandLearnFacts, onceTenant, type BrandLearnFacts, type LearnKind, type LearnVia, type TenantLoad } from "@/lib/loops/learnLog";
import { isEditModeLearningFollowsVizzyEnabled, isEditModeVizzyLearningEnabled } from "./flags";

/**
 * The person's own "Learn from my edits" choice (stored on their membership in the brand) and
 * what they prefer, for Vizzy's prompts. No route or sign-in code, so the Distribute worker and
 * drafting can use it too. Server only.
 */

async function membershipOf(ctx: TenantContext) {
  if (!ctx.userId) return null;
  const [m] = await forTenant(ctx).members.find({ where: [["userId", "==", ctx.userId]], limit: 1 });
  return m ?? null;
}

/** Whether a brand may learn from edits of one kind, and what its log line says about the brand. */
export type LearningAccess =
  | { ok: true; via: LearnVia; facts: BrandLearnFacts }
  | { ok: false; reason: "plan" | "region"; facts: BrandLearnFacts };

/**
 * Whether the brand may learn from edits of this kind (Edit mode or post edits). Reads the brand at
 * most once, for the answer and the facts its loop_learn line carries (src/lib/loops/learnLog.ts).
 *
 * - The learning key, edit_vizzy_learning, through brandCanUse: any kind, any region, as before.
 * - With EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED, Edit mode only: a brand that may use Vizzy in
 *   Edit mode (edit_vizzy) and keeps its data in the agent's region, where Memory Bank is. One in
 *   another region is refused with reason region (ADR-0021).
 * - Otherwise reason plan. Post edits keep the key until step 7 gives them a regional learner.
 */
export async function learningAccess(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  kind: LearnKind,
  load: TenantLoad = getTenantById,
): Promise<LearningAccess> {
  const once = onceTenant(load);
  const key = await brandCanUse(ctx, "edit_vizzy_learning", once);
  const editVizzy = kind === "edit_mode" ? await brandCanUse(ctx, "edit_vizzy", once) : undefined;
  const facts = await brandLearnFacts(ctx, once, editVizzy);
  if (key) return { ok: true, via: "learning_key", facts };
  if (kind === "edit_mode" && editVizzy && isEditModeLearningFollowsVizzyEnabled()) {
    return facts.agentRegion !== null && ctx.region === facts.agentRegion
      ? { ok: true, via: "edit_vizzy", facts }
      : { ok: false, reason: "region", facts };
  }
  return { ok: false, reason: "plan", facts };
}

/** Whether the person has switched learning off in this brand. */
export async function isLearningOff(ctx: TenantContext): Promise<boolean> {
  return (await membershipOf(ctx))?.editLearningOff === true;
}

/** Switch learning off or on for the person in this brand. False: they have no membership. */
export async function setLearningOff(ctx: TenantContext, off: boolean): Promise<boolean> {
  const m = await membershipOf(ctx);
  if (!m) return false;
  await forTenant(ctx).members.update(m.id, { editLearningOff: off });
  return true;
}

/** How long an edit waits for the person's memories before going without them. */
const PREFERENCES_WAIT_MS = 1500;

/** What the person prefers, for Vizzy's prompt in Edit mode or a post draft (the kind decides the
 *  brand's access, as learningAccess does). Empty when learning is off for them or anything goes
 *  wrong: an edit never waits long on, or fails because of, Memory Bank. */
export async function editPreferencesFor(ctx: TenantContext, kind: LearnKind): Promise<string[]> {
  try {
    if (!ctx.userId || !isEditModeVizzyLearningEnabled() || !isMemoryBankConfigured()) return [];
    if (!(await learningAccess(ctx, kind)).ok || (await isLearningOff(ctx))) return [];
    const memories = await Promise.race([
      listEditMemories({ tenantId: ctx.tenantId, userId: ctx.userId }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PREFERENCES_WAIT_MS)),
    ]);
    return (memories ?? []).map((m) => m.text);
  } catch {
    return [];
  }
}
