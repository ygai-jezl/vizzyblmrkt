import { Wordmark } from "./ui";

/** Minimal marketing footer — brand mark + the "dogfood" line, no dead links. */
export function SiteFooter() {
  return (
    <footer className="mx-auto mt-8 w-full max-w-6xl px-6 pb-12">
      <div className="flex flex-col items-center gap-3 border-t border-brand-line pt-8 text-center sm:flex-row sm:justify-between sm:text-left">
        <Wordmark />
        <p className="text-sm text-brand-muted">
          The agentic growth loop — powered by its own platform.
        </p>
      </div>
    </footer>
  );
}
