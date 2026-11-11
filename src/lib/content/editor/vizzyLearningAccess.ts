import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { isMemoryBankConfigured, listEditMemories } from "@/lib/agents/memoryBank";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isEditModeVizzyLearningEnabled } from "./flags";

/**
 * Who Vizzy learns from: the switch, a Memory Bank set up for this copy, the brand's access
 * (brandCanUse), and the person's own choice ("Learn from my edits", stored on their membership
 * in the brand). Off for the person means Vizzy neither learns from nor uses their memories.
 * Server only.
 */

type Ctx = TenantContext & { userId: string };

/** The learning routes' checks, in order: origin, switch, sign-in, set up, brand access. */
export async function guardLearningRoute(req: Request): Promise<{ ctx: Ctx } | { response: NextResponse }> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { response: blocked };
  if (!isEditModeVizzyLearningEnabled()) {
    return { response: NextResponse.json({ error: "learning_disabled" }, { status: 503 }) };
  }
  const ctx = await getAdminContext();
  if (!ctx?.userId) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isMemoryBankConfigured()) {
    return { response: NextResponse.json({ error: "learning_not_configured" }, { status: 503 }) };
  }
  if (!(await brandCanUse(ctx, "edit_vizzy_learning"))) {
    return { response: NextResponse.json({ error: "not_included" }, { status: 403 }) };
  }
  return { ctx: ctx as Ctx };
}

async function membershipOf(ctx: TenantContext) {
  if (!ctx.userId) return null;
  const [m] = await forTenant(ctx).members.find({ where: [["userId", "==", ctx.userId]], limit: 1 });
  return m ?? null;
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

/** What the person prefers, for Vizzy's edit prompt. Empty when learning is off for them or
 *  anything goes wrong: an edit never waits long on, or fails because of, Memory Bank. */
export async function editPreferencesFor(ctx: TenantContext): Promise<string[]> {
  try {
    if (!ctx.userId || !isEditModeVizzyLearningEnabled() || !isMemoryBankConfigured()) return [];
    if (!(await brandCanUse(ctx, "edit_vizzy_learning")) || (await isLearningOff(ctx))) return [];
    const memories = await Promise.race([
      listEditMemories({ tenantId: ctx.tenantId, userId: ctx.userId }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PREFERENCES_WAIT_MS)),
    ]);
    return (memories ?? []).map((m) => m.text);
  } catch {
    return [];
  }
}
