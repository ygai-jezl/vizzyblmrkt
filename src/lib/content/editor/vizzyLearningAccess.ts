import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { TenantContext } from "@/lib/tenant/types";
import { isMemoryBankConfigured } from "@/lib/agents/memoryBank";
import { isEditModeVizzyLearningEnabled } from "./flags";
import { learningAccess } from "./learningChoice";

/**
 * Who Vizzy learns from: the switch, a Memory Bank set up for this copy, the brand's access
 * (learningAccess), and the person's own choice ("Learn from my edits", stored on their membership
 * in the brand). Off for the person means Vizzy neither learns from nor uses their memories.
 * Server only.
 */

type Ctx = TenantContext & { userId: string };

export const learningDisabled = () => NextResponse.json({ error: "learning_disabled" }, { status: 503 });
export const learningNotConfigured = () => NextResponse.json({ error: "learning_not_configured" }, { status: 503 });

/**
 * The answer for a brand that may not learn from edits in Edit mode: not_included for its plan,
 * not_in_region for a brand with Vizzy in Edit mode outside the agent's region (only with
 * EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED). The page hides learning on either.
 */
export function learningRefused(reason: "plan" | "region"): NextResponse {
  return NextResponse.json({ error: reason === "region" ? "not_in_region" : "not_included" }, { status: 403 });
}

/** The learning routes' checks, in order: origin, switch, sign-in, set up, brand access. */
export async function guardLearningRoute(req: Request): Promise<{ ctx: Ctx } | { response: NextResponse }> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { response: blocked };
  if (!isEditModeVizzyLearningEnabled()) return { response: learningDisabled() };
  const ctx = await getAdminContext();
  if (!ctx?.userId) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isMemoryBankConfigured()) return { response: learningNotConfigured() };
  const access = await learningAccess(ctx, "edit_mode");
  if (!access.ok) return { response: learningRefused(access.reason) };
  return { ctx: ctx as Ctx };
}

export { isLearningOff, setLearningOff, editPreferencesFor, learningAccess } from "./learningChoice";
