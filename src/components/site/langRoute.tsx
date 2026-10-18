import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteMetadata } from "@/lib/site/metadata";
import type { OtherLang, SitePage } from "@/lib/site/langs";
import { resolveFeature, resolveLang, resolveStage } from "@/lib/site/routes";
import { FeatureView, HomeView, StageView } from "./views";

/**
 * The site in another language. Each language has its own route folder
 * (src/app/<lang>/[[...path]]) rather than one top-level [lang] segment, which
 * would match every path in the app. `path` is what follows /<lang>:
 * nothing (home), ["loop", stage] or ["features", feature].
 */
function resolve(lang: OtherLang, path: string[] = []): { lang: OtherLang; page: SitePage } | null {
  if (!resolveLang(lang)) return null;
  if (path.length === 0) return { lang, page: { kind: "home" } };
  if (path.length !== 2) return null;
  const [kind, slug] = path as [string, string];
  if (kind === "loop") {
    const r = resolveStage(lang, slug);
    return r ? { lang, page: { kind: "stage", id: r.id } } : null;
  }
  if (kind === "features") {
    const r = resolveFeature(lang, slug);
    return r ? { lang, page: { kind: "feature", slug: r.slug } } : null;
  }
  return null;
}

export type LangRouteProps = { params: Promise<{ path?: string[] }> };

export async function langMetadata(lang: OtherLang, { params }: LangRouteProps): Promise<Metadata> {
  const r = resolve(lang, (await params).path);
  return r ? siteMetadata(r.lang, r.page) : {};
}

export async function LangPage({ lang, params }: LangRouteProps & { lang: OtherLang }) {
  const r = resolve(lang, (await params).path);
  if (!r) notFound();
  const { page } = r;
  if (page.kind === "stage") return <StageView lang={lang} id={page.id} />;
  if (page.kind === "feature") return <FeatureView lang={lang} slug={page.slug} />;
  return <HomeView lang={lang} />;
}
