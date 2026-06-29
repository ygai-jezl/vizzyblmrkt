import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isCanvasAuthConfigured,
  tenantContextFromCanvasToken,
  verifyCanvasContext,
} from "@/lib/canvas/auth";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RAG retrieval for the ADK agents (Vizzy / Campaign Ops). Like /api/agent/canvas
 * this is NOT under /admin: there is no admin session — auth is the signed canvas
 * capability token in `X-Canvas-Context` (reused, not a new secret) minted by the
 * verified admin-chat proxy and echoed by the agent tool. The tenant scope comes
 * from the TOKEN, never the body. Returns a length-capped grounding block the
 * agent injects into its prompt; an empty block (flag off / no matches) just means
 * the agent answers ungrounded.
 */
const Body = z.object({
  campaignId: z.string().min(1),
  query: z.string().min(1).max(4000),
  limit: z.number().int().min(1).max(20).optional(),
  code: z.boolean().optional(),
});

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
  const { campaignId, query, limit, code } = parsed.data;

  const result = await retrieveSemanticKnowledgeContext({
    ctx,
    campaignId,
    queryText: query,
    limit,
    code,
  });
  return NextResponse.json({
    context: result?.formatted ?? "",
    chunks: result?.chunks ?? [],
  });
}
