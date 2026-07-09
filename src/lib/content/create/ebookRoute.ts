import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isEbookEnabled } from "./ebook";
import type { TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { Workspace } from "@/lib/types/workspace";

/**
 * Shared guard for every eBook studio route: same-origin + admin auth + the server flag +
 * workspace ownership + the plan exists AND is an eBook plan. Returns the resolved
 * { ctx, ws, plan } on success, or a ready-to-return NextResponse error. Keeps the four
 * eBook routes uniform (mirrors the checks in post-image/route.ts).
 */
export interface EbookRouteCtx {
  ctx: TenantContext;
  ws: Workspace;
  plan: ContentPlan;
}

export type EbookGuardResult =
  | { error: Response; ok?: undefined }
  | { ok: EbookRouteCtx; error?: undefined };

export async function guardEbookRoute(
  req: Request,
  workspaceId: string,
  planId: string,
): Promise<EbookGuardResult> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { error: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isEbookEnabled()) return { error: NextResponse.json({ error: "ebook_disabled" }, { status: 503 }) };
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  if (plan.topology.hubChannel !== "ebook") {
    return { error: NextResponse.json({ error: "not_ebook" }, { status: 400 }) };
  }
  return { ok: { ctx, ws, plan } };
}
