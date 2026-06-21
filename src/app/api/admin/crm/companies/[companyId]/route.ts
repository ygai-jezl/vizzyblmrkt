import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Company detail + its associated contacts. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { companyId } = await params;
  const company = await forTenant(ctx).companies.getById(companyId);
  if (!company) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const contacts = await forTenant(ctx).contacts.find({
    where: [["companyId", "==", companyId]],
    orderBy: [["createdAt", "desc"]],
    limit: 200,
  });
  return NextResponse.json({ company, contacts });
}
