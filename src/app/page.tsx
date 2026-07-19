import type { Metadata } from "next";
import Script from "next/script";
import { Sora } from "next/font/google";
import {
  CalendarClock,
  BookOpen,
  LayoutTemplate,
  Users,
  BarChart3,
  Globe,
  Database,
  Palette,
  Languages,
} from "lucide-react";
import {
  BlobBackground,
  Section,
  Eyebrow,
  GradientHeading,
  Stat,
  StatRow,
  CTAButton,
  FeatureRow,
  FeatureCard,
} from "@/components/marketing/ui";
import {
  CanvasVisual,
  VizzyChatVisual,
  KnowledgeVisual,
  WaitlistVoiceVisual,
  EmailBuilderVisual,
  BrandKitVisual,
} from "@/components/marketing/visuals";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { SiteFooter } from "@/components/marketing/SiteFooter";

// Self-hosted display face (no external runtime request) for headings; body keeps
// the system stack. Scoped to this page via the CSS variable on the root wrapper.
const display = Sora({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const SITE_URL =
  "https://vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app";

export const metadata: Metadata = {
  title: "YouGrow.ai — The agentic growth loop",
  description:
    "YouGrow.ai is an agentic Content OS: an AI canvas that turns one idea into a whole campaign, a conversational command center, gamified waitlists with voice AI, and a visual email builder — all grounded in your own knowledge. Join the waitlist.",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "YouGrow.ai",
    title: "YouGrow.ai — The agentic growth loop",
    description:
      "An AI canvas that turns one idea into a whole campaign, a conversational command center, and gamified waitlists — all grounded in your own knowledge.",
  },
  twitter: {
    card: "summary_large_image",
    title: "YouGrow.ai — The agentic growth loop",
    description:
      "An agentic Content OS: AI content canvas, conversational command center, and gamified waitlists — grounded in your own knowledge.",
  },
};

const HERO_STATS = [
  { icon: Database, label: "Grounded in your docs, site & code" },
  { icon: Palette, label: "On-brand from your brand kit" },
  { icon: Languages, label: "24 languages" },
  { icon: Globe, label: "US · EU · Asia residency" },
];

const METRICS = [
  { value: "24", label: "content languages" },
  { value: "3", label: "data regions (US · EU · Asia)" },
  { value: "10", label: "AI image styles" },
  { value: "7", label: "email frameworks" },
];

export default function Home() {
  return (
    <div
      className={`${display.variable} min-h-screen bg-brand-bg text-white antialiased`}
    >
      <BlobBackground />
      <SiteHeader />

      <main>
        {/* Hero */}
        <Section id="top" className="pb-16 pt-36 text-center sm:pt-40">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
            <Eyebrow>The agentic growth loop</Eyebrow>
            <GradientHeading
              as="h1"
              className="text-4xl leading-[1.08] sm:text-6xl"
            >
              The AI <em>growth engine</em> for your entire launch.
            </GradientHeading>
            <p className="max-w-2xl text-lg text-brand-muted sm:text-xl">
              From a gamified waitlist to a full content studio, YouGrow&apos;s
              agents research, write, and ship on-brand campaigns — grounded in
              your own knowledge — while the loop compounds.
            </p>

            {/* Primary CTA: our own dogfooded waitlist widget (see <Script> below). */}
            <div
              id="join"
              className="mt-2 w-full max-w-md rounded-2xl border border-brand-line bg-brand-surface p-3 shadow-glow-soft"
            >
              <div
                data-vizzybl-campaign="agentic-growth-loop"
                data-vizzybl-type="WIDGET_2"
              />
            </div>

            <a
              href="#platform"
              className="rounded text-sm text-brand-muted transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg"
            >
              Explore the platform ↓
            </a>
          </div>

          <div className="mt-14">
            <StatRow items={HERO_STATS} />
          </div>
        </Section>

        {/* Feature rows */}
        <div id="platform">
          <FeatureRow
            id="create"
            eyebrow="Create · the content canvas"
            heading={
              <>
                Describe an idea. Get a <em>whole campaign</em>.
              </>
            }
            body="An AI Architect maps a hub-and-spoke content graph on a living canvas, then fills every node — newsletter, blog, LinkedIn, X, Instagram, even a full eBook — with copy grounded in your knowledge."
            bullets={[
              "One hub atomized into channel-native spokes",
              "Every node grounded in your own knowledge",
              "Auto-drafts a brief the moment you connect nodes",
            ]}
            visual={<CanvasVisual />}
          />

          <FeatureRow
            id="vizzy"
            reverse
            eyebrow="Vizzy · your AI command center"
            heading={
              <>
                One chat that runs your <em>go-to-market</em>.
              </>
            }
            body="Vizzy coordinates specialist agents to build email journeys and answer from your knowledge base — streaming its thinking, token by token, in plain language."
            bullets={[
              "Builds multi-step email journeys on your canvas",
              "Answers grounded in your knowledge base",
              "Per-tenant memory, least-privilege identity",
            ]}
            visual={<VizzyChatVisual />}
          />

          <FeatureRow
            id="knowledge"
            eyebrow="Knowledge · retrieval-grounded"
            heading={
              <>
                Grounded in your world, not <em>generic guesses</em>.
              </>
            }
            body="Connect your docs, your website, even private GitHub and GitLab repos. Every email, post, and answer cites your real product instead of hallucinating."
            bullets={[
              "Docs, website & private git repos",
              "Retrieval cited back to the source",
              "Prompt-injection-guarded, tenant-isolated",
            ]}
            visual={<KnowledgeVisual />}
          />

          <FeatureRow
            reverse
            eyebrow="Grow · gamified waitlist + voice"
            heading={
              <>
                A waitlist that recruits for you — and <em>talks back</em>.
              </>
            }
            body="Referral leaderboards and spot-skipping turn every signup into a recruiter, and a post-signup Gemini Live voice chat turns a join into first-party research."
            bullets={[
              "Referral leaderboards & spot-skipping",
              "Post-signup Gemini Live voice conversation",
              "The 'why' captured as first-party golden data",
            ]}
            visual={<WaitlistVoiceVisual />}
          />

          <FeatureRow
            eyebrow="Email · design + automation"
            heading={
              <>
                Design and automate email like a pro, in <em>minutes</em>.
              </>
            }
            body="A visual, block-based builder with describe-the-email AI, subject-line A/B testing, one-off broadcasts, and automated drip journeys."
            bullets={[
              "Drag-and-drop blocks or describe-to-generate",
              "Subject-line A/B testing with winner promotion",
              "Broadcasts + automated drip journeys",
            ]}
            visual={<EmailBuilderVisual />}
          />

          <FeatureRow
            reverse
            eyebrow="Brand Kit · on-brand by default"
            heading={
              <>
                Upload your brand once. Everything stays <em>on-brand</em>.
              </>
            }
            body="Drop in your brand-guidelines PDF; AI extracts your palette, tone, voice, and imagery — then grounds every word and image it generates."
            bullets={[
              "AI-extracted palette, tone, voice & imagery",
              "Grounds both copy and image generation",
              "Set it once, stay on-brand everywhere",
            ]}
            visual={<BrandKitVisual />}
          />
        </div>

        {/* And much more — bento grid */}
        <Section id="much-more" className="py-16 sm:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Eyebrow>The whole Content OS</Eyebrow>
            <GradientHeading className="mt-4 text-3xl sm:text-4xl">
              And a lot <em>more</em> under the hood.
            </GradientHeading>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={CalendarClock} title="Distribute">
              Schedule approved content to a queue and calendar, preview it
              exactly as X, LinkedIn and Instagram render it, and generate
              on-brand images in 10 styles.
            </FeatureCard>
            <FeatureCard icon={BookOpen} title="eBook Studio">
              An AI table of contents becomes streamed, chapter-by-chapter drafts
              with inline generated images — then the book becomes a hub to
              atomize.
            </FeatureCard>
            <FeatureCard icon={LayoutTemplate} title="Curate & Templatize">
              Capture any link, note or screenshot, then turn a post you admire
              into a reusable {"{{token}}"} skeleton you can refill on-brand.
            </FeatureCard>
            <FeatureCard icon={Users} title="Unified CRM">
              Every signup becomes an enriched contact, auto-linked to its company
              by a research agent, with full email-engagement history.
            </FeatureCard>
            <FeatureCard icon={BarChart3} title="Analytics">
              Real-time KPIs the instant they happen, backed by a BigQuery data
              lake for funnel, UTM attribution and email engagement.
            </FeatureCard>
            <FeatureCard icon={Globe} title="Global by design">
              US, EU and Asia data residency, custom sending and widget domains,
              and authoring in 24 languages — voice chat in 23.
            </FeatureCard>
          </div>
        </Section>

        {/* Capability metrics band */}
        <Section className="py-6">
          <div className="grid grid-cols-2 gap-8 rounded-2xl border border-brand-line bg-brand-surface px-8 py-10 text-center sm:grid-cols-4">
            {METRICS.map((m) => (
              <div key={m.label} className="flex flex-col items-center">
                <Stat value={m.value} label={m.label} />
              </div>
            ))}
          </div>
        </Section>

        {/* Final CTA */}
        <Section className="py-20 sm:py-28">
          <div className="relative overflow-hidden rounded-3xl border border-brand-line bg-brand-surface px-6 py-16 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-70"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 30% 0%, rgba(99,102,241,0.18) 0%, transparent 55%)," +
                  "radial-gradient(circle at 75% 100%, rgba(139,92,246,0.16) 0%, transparent 55%)",
              }}
            />
            <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-6">
              <GradientHeading className="text-3xl sm:text-5xl">
                Ready to grow on <em>autopilot</em>?
              </GradientHeading>
              <p className="text-lg text-brand-muted">
                Join the waitlist and be first to run your whole go-to-market from
                one agentic platform.
              </p>
              <CTAButton href="#join">Join the waitlist</CTAButton>
            </div>
          </div>
        </Section>
      </main>

      <SiteFooter />

      {/*
        Loads our embed loader from the canonical PLATFORM ORIGIN (yougrow.ai —
        see NEXT_PUBLIC_PLATFORM_ORIGIN / src/lib/platform/origin.ts). The loader
        derives its iframe origin from its own script src, so the widget — and
        every signup — routes to prod even when this page is viewed on the dev
        deploy or locally. It MUST be the platform origin, not the raw
        *.hosted.app deploy URL: that bare host is in no tenant's allowedOrigins
        (or maps to the wrong tenant), so the embed's host→tenant resolution
        fails and renders a 404. yougrow.ai resolves to the dogfood tenant that
        owns the agentic-growth-loop campaign, so the widget renders.
        "afterInteractive" injects the tag after hydration, so the
        data-vizzybl-campaign div above is already in the DOM when scan() runs.
      */}
      <Script src="https://yougrow.ai/embed.js" strategy="afterInteractive" />
    </div>
  );
}
