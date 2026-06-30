import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { KnowledgeOwnerKind } from "@/lib/types/knowledgeBase";
import type { WhereClause } from "@/lib/tenant/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List ingestion tickets ("sources") for an owner (workspace|campaign), newest
 * first. Optional `topic`/`tag` filters are applied in memory (per-owner ticket
 * counts are small) to avoid extra composite indexes. With no owner, lists the
 * tenant's recent tickets.
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const ownerKindRaw = sp.get("ownerKind");
  const ownerId = sp.get("ownerId");
  const topic = sp.get("topic");
  const tag = sp.get("tag");

  const where: WhereClause[] = [];
  if (ownerKindRaw && ownerId) {
    const ok = KnowledgeOwnerKind.safeParse(ownerKindRaw);
    if (!ok.success) {
      return NextResponse.json({ error: "invalid_owner_kind" }, { status: 400 });
    }
    where.push(["ownerKind", "==", ok.data], ["ownerId", "==", ownerId]);
  }

  let tickets = await forTenant(ctx).ingestionTickets.find({ where, limit: 200 });
  if (topic) tickets = tickets.filter((t) => t.topic === topic);
  if (tag) tickets = tickets.filter((t) => (t.tags ?? []).includes(tag));
  tickets.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return NextResponse.json({ tickets });
}
