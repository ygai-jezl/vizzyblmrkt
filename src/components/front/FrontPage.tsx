import type { Metadata } from "next";
import Link from "next/link";
import { GITHUB_URL } from "@/lib/site/home";

/** Title and description for the plain front page (no canonical address: it belongs to whoever runs this copy). */
export const FRONT_PAGE_METADATA: Metadata = {
  title: "YouGrow",
  description: "YouGrow is an open source growth platform: waitlists, lifecycle journeys, content and social posts, run with an AI agent.",
};

/**
 * `/` when SITE_HOME_ENABLED is off: the product name, one line about it, a way in and a
 * pointer to the docs. Styled like the sign-in page, so a self-hosted copy looks like
 * itself rather than like the YouGrow marketing site.
 */
export function FrontPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">YouGrow</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Waitlists, lifecycle journeys, content and social posts, run with an AI agent.
        </p>
      </div>
      <Link
        href="/login"
        className="w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Sign in
      </Link>
      <p className="text-xs text-neutral-400">
        <a href={`${GITHUB_URL}#readme`} className="underline hover:text-neutral-600 dark:hover:text-neutral-200" target="_blank" rel="noreferrer">
          Docs on GitHub
        </a>
      </p>
    </main>
  );
}
