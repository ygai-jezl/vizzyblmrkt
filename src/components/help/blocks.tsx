import type { ReactNode } from "react";
import Link from "next/link";
import { Note, OL, Pairs, UL } from "@/components/developers/Doc";
import { nextHelpPage } from "@/lib/help/pages";

/**
 * The building blocks every how-to page uses, in this order: Meta, Before and
 * Unlocks, a Warning where the order matters, Steps, Checks, Messages, NextPage.
 * Built from the Doc blocks and plain elements, so each page's Markdown copy
 * comes from the same tree (src/lib/developers/markdown.ts).
 */

/** Time, who can do it and how often: "About 10 minutes · Admins · Once per brand". */
export function Meta({ items }: { items: string[] }) {
  return <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{items.join(" · ")}</p>;
}

function Box({ title, tone, children }: { title: string; tone: "plain" | "accent"; children: ReactNode }) {
  const cls =
    tone === "accent"
      ? "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40"
      : "border-neutral-200 dark:border-neutral-800";
  return (
    <div className={`rounded-lg border px-4 py-3 ${cls}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{title}</p>
      <UL>{children}</UL>
    </div>
  );
}

/** "Before you start" and "This unlocks", side by side. Children are <li>s. */
export function BeforeAndUnlocks({ before, unlocks }: { before: ReactNode; unlocks: ReactNode }) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      <Box title="Before you start" tone="plain">
        {before}
      </Box>
      <Box title="This unlocks" tone="accent">
        {unlocks}
      </Box>
    </div>
  );
}

/** Where the order matters: what goes wrong if this is done late or skipped. */
export function Warning({ children }: { children: ReactNode }) {
  return <Note tone="warn">{children}</Note>;
}

/** The numbered steps. Children are <li>s. */
export function Steps({ children }: { children: ReactNode }) {
  return <OL>{children}</OL>;
}

/** A link into the app, e.g. <Open href="/admin/account">Settings › Sending</Open>. */
export function Open({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
      {children}
    </Link>
  );
}

/** How to tell it worked. Children are <li>s. */
export function Checks({ children }: { children: ReactNode }) {
  return <UL>{children}</UL>;
}

/**
 * Messages the app shows, and what to do about each. The first column is the
 * app's own words, quoted exactly: help.test.ts checks each one still appears in src.
 */
export function Messages({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <Pairs head={["If you see", "What to do"]} rows={rows.map(([m, fix]) => [`"${m}"`, fix])} />;
}

/** The link to the next page in reading order. */
export function NextPage({ slug }: { slug: string }) {
  const next = nextHelpPage(slug);
  if (!next) return null;
  return (
    <p className="mt-12 border-t border-neutral-200 pt-4 text-sm dark:border-neutral-800">
      Next:{" "}
      <Link href={next.path} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
        {next.label}
      </Link>
    </p>
  );
}
