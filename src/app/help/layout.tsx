import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HELP_GROUPS, shownHelpPages } from "@/lib/help/pages";
import { isHelpPagesEnabled } from "@/lib/help/flags";
import { HelpNav } from "@/components/help/HelpNav";
import { BaseJsonLd } from "@/components/site/JsonLd";

export const dynamic = "force-dynamic";

/** Public how-to pages for setting up and running YouGrow, in the order it's done. */
export default function HelpLayout({ children }: { children: ReactNode }) {
  if (!isHelpPagesEnabled()) notFound();
  const pages = shownHelpPages();
  const groups = HELP_GROUPS.map((g) => ({ ...g, pages: pages.filter((p) => p.group === g.key) }));
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <BaseJsonLd />
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/help" className="text-sm font-semibold">
            YouGrow <span className="font-normal text-neutral-500">Help</span>
          </Link>
          <span className="flex-1" />
          <Link href="/developers" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
            Developers
          </Link>
          <Link
            href="/admin"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-neutral-900"
          >
            Open YouGrow
          </Link>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-[13rem_1fr]">
        <nav className="text-sm md:sticky md:top-6 md:self-start" aria-label="Help pages">
          <HelpNav groups={groups.map((g) => ({ key: g.key, label: g.label, pages: g.pages.map((p) => ({ path: p.path, label: p.label })) }))} />
          <p className="mt-6 hidden text-xs leading-5 text-neutral-500 md:block">
            For AI assistants:{" "}
            <a href="/help/llms.txt" className="underline hover:text-neutral-900 dark:hover:text-white">
              llms.txt
            </a>{" "}
            ·{" "}
            <a href="/help/llms-full.txt" className="underline hover:text-neutral-900 dark:hover:text-white">
              every page as Markdown
            </a>
          </p>
        </nav>
        <main className="min-w-0 max-w-3xl pb-24">{children}</main>
      </div>
    </div>
  );
}
