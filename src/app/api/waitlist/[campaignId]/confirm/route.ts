import { handleSiteConfirmPost } from "@/lib/waitlist/siteConfirmHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Confirm subscription button for a site sign-up (LAUNCH_SITE_SIGNUPS_ENABLED). */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  return handleSiteConfirmPost(req, (await params).campaignId);
}
