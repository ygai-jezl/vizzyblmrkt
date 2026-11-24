import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LegalDoc } from "./LegalDoc";
import { LEGAL_LABELS, legalLinks, legalPage, legalTitle, type LegalSlug } from "@/lib/legal/pages";
import { siteOrigin } from "@/lib/site/flags";
import "./legal.css";

/** Metadata for a legal page: its own title and canonical; not indexed while it doesn't show. */
export function legalMetadata(slug: LegalSlug): Metadata {
  const markdown = legalPage(slug);
  const origin = siteOrigin();
  return {
    title: markdown ? legalTitle(slug, markdown) : LEGAL_LABELS[slug],
    robots: { index: markdown !== null, follow: markdown !== null },
    alternates: origin ? { canonical: `${origin}/${slug}` } : undefined,
  };
}

/**
 * One legal page, from the deployment's `legal/<slug>.md`. 404 when its switch is off, the
 * file is missing, or a `[...]` placeholder is left. English only: a contract is not translated.
 */
export function LegalPage({ slug }: { slug: LegalSlug }) {
  const markdown = legalPage(slug);
  if (!markdown) notFound();
  const others = legalLinks().filter((l) => l.href !== `/${slug}`);
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
          <Link href="/" className="text-sm font-semibold">
            YouGrow
          </Link>
          <span className="flex-1" />
          {others.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
              {l.label}
            </Link>
          ))}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <article lang="en">
          <LegalDoc markdown={markdown} />
        </article>
      </main>
    </div>
  );
}
