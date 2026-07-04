import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The LinkedIn authors this tenant can publish as — for the "Post as" picker.
 * `urn: null` = the connected member (personal); an org urn = a Company Page the
 * member administers (from the linkedin_org connection's discovered pages).
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const authors: Array<{ urn: string | null; label: string }> = [];
  const personal = tenant?.socialConnections?.linkedin;
  if (personal) authors.push({ urn: null, label: `You${personal.handle ? ` — ${personal.handle}` : ""}` });
  for (const o of tenant?.socialConnections?.linkedin_org?.orgs ?? []) {
    authors.push({ urn: o.urn, label: o.name ?? o.urn });
  }
  return NextResponse.json({ authors });
}
