import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StageView } from "@/components/site/views";
import { siteMetadata } from "@/lib/site/metadata";
import { resolveStage } from "@/lib/site/routes";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ stage: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = resolveStage(undefined, (await params).stage);
  return r ? siteMetadata(r.lang, { kind: "stage", id: r.id }) : {};
}

/** A stage of the growth loop (English). 404 while SITE_LOOP_ENABLED is off. */
export default async function StagePage({ params }: Props) {
  const r = resolveStage(undefined, (await params).stage);
  if (!r) notFound();
  return <StageView lang={r.lang} id={r.id} />;
}
