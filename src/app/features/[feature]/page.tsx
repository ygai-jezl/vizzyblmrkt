import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FeatureView } from "@/components/site/views";
import { siteMetadata } from "@/lib/site/metadata";
import { resolveFeature } from "@/lib/site/routes";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ feature: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = resolveFeature(undefined, (await params).feature);
  return r ? siteMetadata(r.lang, { kind: "feature", slug: r.slug }) : {};
}

/** A feature's page and walkthrough (English). 404 while SITE_LOOP_ENABLED is off. */
export default async function FeaturePage({ params }: Props) {
  const r = resolveFeature(undefined, (await params).feature);
  if (!r) notFound();
  return <FeatureView lang={r.lang} slug={r.slug} />;
}
