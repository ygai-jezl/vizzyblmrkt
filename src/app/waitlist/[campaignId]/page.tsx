import { hostedMetadata, renderHostedPage } from "./hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** A launch's hosted page in its own language (./hosted.tsx). */
export async function generateMetadata({ params, searchParams }: Props) {
  return hostedMetadata((await params).campaignId, await searchParams, null);
}

export default async function HostedWaitlistPage({ params, searchParams }: Props) {
  return renderHostedPage((await params).campaignId, await searchParams, null);
}
