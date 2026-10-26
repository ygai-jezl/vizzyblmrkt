import { handleRotateSiteKey } from "@/lib/waitlist/siteKeyAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rotate secret: the new one comes back this once; the old one works 24 hours more. */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  return handleRotateSiteKey(req, (await params).campaignId);
}
