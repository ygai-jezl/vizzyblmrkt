import { NextResponse } from "next/server";
import { z } from "zod";
import { forTenant } from "@/lib/tenant";
import {
  isCanvasAuthConfigured,
  tenantContextFromCanvasToken,
  verifyCanvasContext,
} from "@/lib/canvas/auth";
import { canvasKindNames, getCanvasKind } from "@/lib/canvas/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent canvas authoring endpoint. The Campaign Ops Agent (an ADK sub-agent of
 * Vizzy) calls this to save a journey DRAFT. NOT under /admin: there is no admin
 * session here — auth is the signed capability token in `X-Canvas-Context`,
 * minted by the verified admin-chat proxy and echoed back by the agent tool. The
 * tenant scope is reconstructed from the TOKEN, never from the body.
 *
 * Kind-generic: a second canvas type just registers a new kind (see
 * src/lib/canvas/registry.ts) — nothing here changes. `action` is intentionally
 * limited to "save_draft": this route can never activate a journey.
 */
const Body = z.object({
  kind: z.string().min(1),
  campaignId: z.string().min(1),
  brief: z.string().max(4000).optional(),
  graph: z.unknown(),
  action: z.literal("save_draft"),
});

export async function POST(req: Request) {
  if (!isCanvasAuthConfigured()) {
    return NextResponse.json({ error: "canvas_auth_unconfigured" }, { status: 503 });
  }

  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: verified.error },
      { status: 401 },
    );
  }
  const ctx = tenantContextFromCanvasToken(verified.claims);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { kind, campaignId, brief, graph } = parsed.data;

  const canvasKind = getCanvasKind(kind);
  if (!canvasKind) {
    return NextResponse.json(
      { error: "unknown_kind", known: canvasKindNames() },
      { status: 400 },
    );
  }

  // Load the campaign in the token's tenant scope. A wrong/cross-tenant id can
  // only ever resolve within this tenant (TenantCollection refuses others) → 404.
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const outcome = await canvasKind.authorDraft({
    ctx,
    campaign,
    campaignId,
    rawGraph: graph,
    brief: brief ?? "",
  });

  if (!outcome.ok) {
    const status =
      outcome.error === "campaign_not_found"
        ? 404
        : outcome.error === "journey_active"
          ? 409
          : 422; // invalid_graph
    return NextResponse.json(
      {
        error: outcome.error,
        ...(outcome.issues ? { issues: outcome.issues } : {}),
      },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    kind,
    journeyId: outcome.journeyId,
    status: outcome.status,
    warnings: outcome.warnings,
    summary: buildSummary(canvasKind.label, outcome.status, outcome.warnings),
  });
}

function buildSummary(
  label: string,
  status: string,
  warnings: string[],
): string {
  const base =
    `I built the ${label} and saved it as a ${status}. ` +
    `Open the Journey Canvas to review the copy, then click Activate when you're happy — ` +
    `I won't send anything to your subscribers until you do.`;
  if (warnings.length === 0) return base;
  return `${base} Heads up: ${warnings.join("; ")}.`;
}
