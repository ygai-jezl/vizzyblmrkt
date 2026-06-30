import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { KnowledgeOwnerKind } from "@/lib/types/knowledgeBase";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SearchSchema = z.object({
  ownerKind: KnowledgeOwnerKind,
  ownerId: z.string().min(1),
  query: z.string().min(1).max(4000),
  topic: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

/**
 * Admin test-retrieval: run the same nearest-neighbour retrieval an agent would,
 * for an owner the operator owns, with an optional topic OR tag pre-filter.
 * Bypasses KNOWLEDGE_RAG_ENABLED (explicit operator test).
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = SearchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { ownerKind, ownerId, query, topic, tag, limit } = parsed.data;
  // Combined topic+tag filtering needs a 3-field composite index (deferred).
  if (topic && tag) {
    return NextResponse.json({ error: "filter_one_at_a_time" }, { status: 400 });
  }

  const result = await retrieveSemanticKnowledgeContext({
    ctx,
    ownerKind,
    ownerId,
    queryText: query,
    limit,
    filter: { topic: topic || undefined, tag: tag || undefined },
    bypassEnabledFlag: true,
  });
  return NextResponse.json({
    context: result?.formatted ?? "",
    chunks: result?.chunks ?? [],
  });
}
