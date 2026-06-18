import type { Metadata } from "next";
import Script from "next/script";

const SITE_URL =
  "https://vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app";

export const metadata: Metadata = {
  title: "YouGrow.ai — The agentic growth loop",
  description:
    "YouGrow.ai turns your launch into a self-optimizing growth loop: gamified waitlists, viral referrals, and agents that tune your campaign while you sleep. Join the waitlist.",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "YouGrow.ai",
    title: "YouGrow.ai — The agentic growth loop",
    description:
      "Gamified waitlists, viral referrals, and agentic campaign optimization. Join the waitlist.",
  },
  twitter: {
    card: "summary_large_image",
    title: "YouGrow.ai — The agentic growth loop",
    description:
      "Gamified waitlists, viral referrals, and agentic campaign optimization.",
  },
};

const VALUE_PROPS = [
  {
    title: "An agentic growth loop",
    body: "Background agents continuously tune your copy, timing, and targeting against your goal — so the loop gets sharper every day without you touching it.",
  },
  {
    title: "Gamified & viral by default",
    body: "Referral leaderboards and spot-skipping turn every signup into a recruiter. Your waitlist compounds instead of stalling.",
  },
  {
    title: "Multi-tenant & region-ready",
    body: "Per-tenant data residency (US / EU / Asia) and full isolation are built in — launch anywhere, stay compliant everywhere.",
  },
];

const STEPS = [
  "Build a launch and drop your waitlist widget onto any site.",
  "Signups refer friends, climb the leaderboard, and skip the queue.",
  "Agents optimize the loop and surface your highest-intent leads.",
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-24 px-6 py-20">
      {/* Hero — primary CTA is our own embedded waitlist widget */}
      <section className="flex flex-col items-center gap-8 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
          YouGrow.ai
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          The agentic growth loop
        </h1>
        <p className="max-w-2xl text-lg text-neutral-600 dark:text-neutral-400">
          Turn your launch into a self-optimizing growth engine. Gamified
          waitlists, viral referrals, and agents that tune your campaign while
          you sleep.
        </p>

        {/* Dogfooded WIDGET_2 (Mini) capture — see <Script> at the foot of <main> */}
        <div className="w-full max-w-md rounded-xl border border-neutral-200 p-2 dark:border-neutral-800">
          <div
            data-vizzybl-campaign="agentic-growth-loop"
            data-vizzybl-type="WIDGET_2"
          />
        </div>
      </section>

      {/* Value props */}
      <section className="grid gap-8 sm:grid-cols-3">
        {VALUE_PROPS.map((prop) => (
          <div key={prop.title} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold tracking-tight">
              {prop.title}
            </h2>
            <p className="text-neutral-600 dark:text-neutral-400">
              {prop.body}
            </p>
          </div>
        ))}
      </section>

      {/* How it works */}
      <section className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step} className="flex flex-col gap-2">
              <span className="text-sm font-medium text-neutral-400">
                Step {i + 1}
              </span>
              <p className="text-neutral-600 dark:text-neutral-400">{step}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-200 pt-8 text-sm text-neutral-500 dark:border-neutral-800">
        YouGrow.ai — powered by its own platform.
      </footer>

      {/*
        Loads our embed loader, pinned to the PRODUCTION /embed.js. The loader
        derives its iframe origin from its own script src, so this routes the widget
        — and therefore every waitlist signup — to the prod environment even when
        this page is viewed on the dev deploy or locally. The agentic-growth-loop
        campaign must exist in prod for the widget to render. "afterInteractive"
        injects the tag after hydration, so the data-vizzybl-campaign div above is
        already in the DOM when the loader's scan() runs.
      */}
      <Script
        src="https://vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app/embed.js"
        strategy="afterInteractive"
      />
    </main>
  );
}
