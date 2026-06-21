import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContactEmailHistory } from "@/lib/crm/emailHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Contact detail + the expandable email-history sub-list (from email_events). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { contactId } = await params;
  const contact = await forTenant(ctx).contacts.getById(contactId);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const emails = await getContactEmailHistory(ctx, contact);
  const company = contact.companyId
    ? await forTenant(ctx).companies.getById(contact.companyId)
    : null;
  return NextResponse.json({ contact, company, emails });
}
