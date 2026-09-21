import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isCanvasAuthConfigured,
  tenantContextFromCanvasToken,
  verifyCanvasContext,
} from "@/lib/canvas/auth";
import { canvasKindNames, getCanvasKind } from "@/lib/canvas/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent canvas authoring endpoint. Vizzy's specialists (Campaign Ops for launch
 * journeys, Lifecycle Ops for connected-product journeys) call this to save a
 * DRAFT. NOT under /admin: there is no admin session here — auth is the signed
 * capability token in `X-Canvas-Context`, minted by the verified admin-chat
 * proxy and echoed back by the agent tool. The tenant scope is reconstructed
 * from the TOKEN, never from the body.
 *
 * Kind-generic: each kind parses its own scope (a launch, or a product
 * connection + journey) and writes its own summary. `action` is limited to
 * "save_draft": this route can never activate or publish anything.
 */
const Body = z
  .object({
    kind: z.string().min(1),
    brief: z.string().max(4000).optional(),
    action: z.literal("save_draft"),
  })
  .passthrough();

export async function POST(req: Request) {
  if (!isCanvasAuthConfigured()) {
    return NextResponse.json({ error: "canvas_auth_unconfigured" }, { status: 503 });
  }

  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) {
    return NextResponse.json({ error: "unauthorized", reason: verified.error }, { status: 401 });
  }
  const ctx = tenantContextFromCanvasToken(verified.claims);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { kind, brief } = parsed.data;

  const canvasKind = getCanvasKind(kind);
  if (!canvasKind) {
    return NextResponse.json({ error: "unknown_kind", known: canvasKindNames() }, { status: 400 });
  }

  const outcome = await canvasKind.authorDraft({ ctx, input: parsed.data, brief: brief ?? "" });
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, ...(outcome.issues ? { issues: outcome.issues } : {}) },
      { status: outcome.status },
    );
  }

  return NextResponse.json({
    ok: true,
    kind,
    id: outcome.id,
    // Kept for the Campaign Ops client, which reads `journeyId`.
    journeyId: outcome.id,
    status: outcome.status,
    url: outcome.url,
    warnings: outcome.warnings,
    summary: outcome.summary,
    card: outcome.card,
  });
}
