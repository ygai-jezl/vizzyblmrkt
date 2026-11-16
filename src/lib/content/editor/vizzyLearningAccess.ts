import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { TenantContext } from "@/lib/tenant/types";
import { isMemoryBankConfigured } from "@/lib/agents/memoryBank";
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

export { isLearningOff, setLearningOff, editPreferencesFor } from "./learningChoice";
