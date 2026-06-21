import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { enqueueEmailJob } from "@/lib/email/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GDPR Art.17 erasure of a contact (§H2). Admin-only — it irreversibly deletes
 * the contact + its email engagement and unsubscribes externally. Enqueues a
 * `contact_erase` job (the cascade runs in the worker, idempotently).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { contactId } = await params;
  const contact = await forTenant(ctx).contacts.getById(contactId);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await enqueueEmailJob(ctx, {
    type: "contact_erase",
    campaignId: contact.campaignIds[0] ?? "manual",
    dedupeKey: `erase:contact:${contactId}`,
    payload: { contactId },
  });
  return NextResponse.json({ ok: true, status: "queued" });
}
