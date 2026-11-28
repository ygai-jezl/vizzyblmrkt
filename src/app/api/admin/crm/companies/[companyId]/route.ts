import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { removeCompany } from "@/lib/crm/companyRemove";
import { removeCompanyAdmin } from "@/lib/crm/paste/admin";

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

const REMOVE_LIMIT = { prefix: "company_remove", burstLimit: 20, hourlyLimit: 200 };

/**
 * Remove company (RAISE_PASTE_ENABLED), admins only: a company with no people goes, with its own
 * field values and its history. 409 `has_people` while anyone has it as their company: it goes
 * when its last person is erased.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const gate = await removeCompanyAdmin(req);
  if (!gate.ok) return gate.response;
  const noStore = { "cache-control": "no-store" };
  if (await isRateLimited(`user:${gate.ctx.tenantId}:${gate.ctx.userId}`, REMOVE_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  }
  const { companyId } = await params;
  const r = await removeCompany(gate.ctx, companyId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "has_people" ? 409 : 404, headers: noStore });
  return NextResponse.json({ removed: true }, { headers: noStore });
}
