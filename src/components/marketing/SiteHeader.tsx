import { Wordmark } from "./ui";

const NAV = [
  { href: "#create", label: "Create" },
  { href: "#vizzy", label: "Agents" },
  { href: "#knowledge", label: "Knowledge" },
  { href: "#much-more", label: "More" },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg";

/** Fixed glass header — the Vizzybl `bg/80 + backdrop-blur` chrome. */
export function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-brand-line/60 bg-brand-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark href="#top" size="lg" />

        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={`rounded text-sm text-brand-muted transition-colors hover:text-white ${FOCUS_RING}`}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <a
          href="#join"
          className={`rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-glow ${FOCUS_RING}`}
        >
          Join the waitlist
        </a>
      </div>
    </header>
  );
}
