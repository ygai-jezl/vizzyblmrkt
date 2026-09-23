import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDevelopersDocsEnabled } from "@/lib/developers/flags";

export const dynamic = "force-dynamic";

export const metadata = { title: "Developers — YouGrow" };

const NAV = [
  { href: "/developers", label: "Overview" },
  { href: "/developers/events", label: "Sending events" },
  { href: "/developers/context-endpoint", label: "Context endpoint" },
  { href: "/developers/webhooks", label: "Webhooks" },
  { href: "/developers/security", label: "Signing & verifying" },
];

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
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 max-w-3xl pb-24">{children}</main>
      </div>
    </div>
  );
}
