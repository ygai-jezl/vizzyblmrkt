import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOC_PAGES } from "@/lib/developers/docs";
import { isDevelopersDocsEnabled } from "@/lib/developers/flags";

export const dynamic = "force-dynamic";

export const metadata = { title: "Developers — YouGrow" };

/** Public developer docs for connecting a product to YouGrow lifecycle journeys. */
export default function DevelopersLayout({ children }: { children: ReactNode }) {
  if (!isDevelopersDocsEnabled()) notFound();
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/developers" className="text-sm font-semibold">
            YouGrow <span className="font-normal text-neutral-500">Developers</span>
          </Link>
          <Link href="/admin/products" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
            Products →
          </Link>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-[12rem_1fr]">
        <nav className="text-sm md:sticky md:top-6 md:self-start" aria-label="Developer docs">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 md:block md:space-y-1">
            {DOC_PAGES.map((n) => (
              <li key={n.path}>
                <Link href={n.path} className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-5 text-neutral-500 md:mt-8">
            For coding agents:{" "}
            <a href="/llms.txt" className="underline hover:text-neutral-900 dark:hover:text-white">
              llms.txt
            </a>{" "}
            ·{" "}
            <a href="/developers/llms-full.txt" className="underline hover:text-neutral-900 dark:hover:text-white">
              every page as Markdown
            </a>
          </p>
        </nav>
        <main className="min-w-0 max-w-3xl pb-24">{children}</main>
      </div>
    </div>
  );
}
