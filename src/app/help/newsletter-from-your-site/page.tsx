import { notFound } from "next/navigation";
import NewsletterFromYourSiteHelp from "@/components/help/pages/newsletter-from-your-site";
import { helpMetadata } from "@/lib/help/metadata";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

export const dynamic = "force-dynamic";

/** Worked out per request, so the description names a waitlist while launches are called ideas. */
export function generateMetadata() {
  return helpMetadata("newsletter-from-your-site");
}

/** Served only while LAUNCH_SITE_SIGNUPS_ENABLED is on. */
export default function Page() {
  if (!isSiteSignupsEnabled()) notFound();
  return <NewsletterFromYourSiteHelp />;
}
