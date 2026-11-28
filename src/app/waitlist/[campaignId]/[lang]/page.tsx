import { notFound } from "next/navigation";
import { isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { hostedMetadata, renderHostedPage } from "../hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ campaignId: string; lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** A launch's hosted page in one of its other languages (PAGE_LANGUAGES_ENABLED; ../hosted.tsx). */
export async function generateMetadata({ params, searchParams }: Props) {
  const { campaignId, lang } = await params;
  return hostedMetadata(campaignId, await searchParams, lang.toLowerCase());
}

export default async function HostedWaitlistLanguagePage({ params, searchParams }: Props) {
  if (!isPageLanguagesEnabled()) notFound();
  const { campaignId, lang } = await params;
  // Codes are two letters, like "fr"; anything else isn't a page.
  if (!/^[a-z]{2}$/.test(lang)) notFound();
  return renderHostedPage(campaignId, await searchParams, lang);
}
