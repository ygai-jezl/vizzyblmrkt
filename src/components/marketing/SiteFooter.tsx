import Link from "next/link";
import { legalLinks } from "@/lib/legal/pages";
import { Wordmark } from "./ui";

/** Minimal marketing footer: brand mark, the "dogfood" line and the legal pages this copy has. */
export function SiteFooter() {
  const legal = legalLinks();
  return (
    <footer className="mx-auto mt-8 w-full max-w-6xl px-6 pb-12">
      <div className="flex flex-col items-center gap-3 border-t border-brand-line pt-8 text-center sm:flex-row sm:justify-between sm:text-left">
        <Wordmark />
        <p className="text-sm text-brand-muted">
          The agentic growth loop — powered by its own platform.
        </p>
      </div>
      {legal.length ? (
        <nav aria-label="Legal" className="mt-4 flex justify-center gap-6 text-sm text-brand-muted sm:justify-start">
          {legal.map((l) => (
            <Link key={l.href} href={l.href} className="hover:underline">
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </footer>
  );
}
