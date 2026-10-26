import { handleSiteSignup } from "@/lib/waitlist/siteSignupHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-ups from a brand's own site: add one email to the site key's launch (LAUNCH_SITE_SIGNUPS_ENABLED). */
export async function POST(req: Request) {
  return handleSiteSignup(req);
}
