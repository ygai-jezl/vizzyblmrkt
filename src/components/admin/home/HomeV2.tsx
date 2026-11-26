import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BookOpen, Check, Lock, TriangleAlert } from "lucide-react";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { HowToLink } from "@/components/help/HowToLink";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { shouldWelcome } from "@/lib/onboarding/firstVisit";
import { nextActionStage, nextActionTitle } from "@/lib/onboarding/homeOrder";
import { isNextActionCardEnabled } from "@/lib/nextAction/flags";
import { cardFits, homeNextAction, homeSignalOptions } from "@/lib/nextAction/service";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { computeGrowth, nextStepOf, type StageView } from "@/lib/nav/growth";
import { ideaWord } from "@/lib/nav/terms";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { loadGrowthSignals, loadWeekCounts } from "@/lib/nav/growthSignals";
import { homeTiles } from "@/lib/nav/homeTiles";
import { homePrompts } from "@/lib/nav/vizzy";
import { loadReview, type ReviewItem } from "@/lib/review/summary";
import { DashboardChat } from "../chat/DashboardChat";
import { AskChips } from "./AskChips";
import { NextActionCard } from "./NextActionCard";

const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-shell-muted";
const CARD = "rounded-xl border border-shell-line bg-shell-card p-4";

function GrowthTrack({ stages }: { stages: StageView[] }) {
  return (
    <ol
      aria-label="Your growth path"
      className={`grid gap-px overflow-hidden rounded-xl border border-shell-line bg-shell-line ${
        stages.length === 5
          ? "sm:grid-cols-2 xl:grid-cols-5"
          : stages.length === 4
            ? "sm:grid-cols-2 lg:grid-cols-4"
            : "sm:grid-cols-2"
      }`}
    >
      {stages.map((stage, i) => {
        const href = (nextStepOf(stage) ?? stage.steps[0]!).href;
        return (
          <li
            key={stage.key}
            className={`${stage.status === "current" ? "bg-shell-accent-soft" : "bg-shell-card"} ${
              // An odd last stage fills its row rather than leaving a gap.
              stages.length % 2 === 1 && i === stages.length - 1 ? "sm:col-span-2 xl:col-span-1" : ""
            }`}
          >
            <Link
              href={href}
              aria-current={stage.status === "current" ? "step" : undefined}
              className="flex items-center gap-3 px-4 py-3 hover:bg-shell-hover"
            >
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                  stage.status === "done"
                    ? "bg-shell-ink text-shell-side"
                    : stage.status === "current"
                      ? "border-2 border-shell-accent bg-shell-card text-shell-accent"
                      : "border border-shell-faint text-shell-muted"
                }`}
              >
                {stage.status === "done" ? <Check size={14} strokeWidth={3} aria-label="Done" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${stage.status === "next" ? "text-shell-muted" : "text-shell-ink"}`}>
                  {stage.label}
                </span>
                <span className="block truncate text-xs text-shell-muted">{stage.summary}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function NextSteps({ stage, title }: { stage: StageView; title: string }) {
  const done = stage.steps.filter((s) => s.done).length;
  const next = nextStepOf(stage);
  return (
    <section className={CARD}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-shell-muted">
          {done} of {stage.steps.length} done
        </span>
      </div>
      <ul className="space-y-1">
        {stage.steps.map((step) => {
          const locked = !step.done && !!step.needs;
          return (
            <li key={step.label} className="flex items-start gap-2.5 py-1">
              {locked ? (
                <Lock size={14} aria-label="Needs another step first" className="mt-0.5 h-4 w-4 shrink-0 text-shell-faint" />
              ) : (
                <span
                  className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
                    step.done ? "bg-shell-ink text-shell-side" : step === next ? "border-2 border-shell-accent" : "border border-shell-faint"
                  }`}
                >
                  {step.done ? <Check size={10} strokeWidth={3.5} aria-label="Done" /> : null}
                </span>
              )}
              <span className="min-w-0 flex-1 text-sm">
                {step.done || locked ? (
                  <span className="text-shell-muted">{step.label}</span>
                ) : (
                  <Link href={step.href} className="text-shell-ink hover:underline">
                    {step.label}
                  </Link>
                )}
                {step.optional && !step.done ? <span className="ml-1.5 text-xs text-shell-faint">Optional</span> : null}
                {locked ? (
                  <span className="block text-xs text-shell-muted">
                    Needs:{" "}
                    {step.needs!.map((n, i) => (
                      <span key={n.label}>
                        {i > 0 ? ", " : null}
                        <Link href={n.href} className="text-shell-accent hover:underline">
                          {n.label}
                        </Link>
                      </span>
                    ))}
                  </span>
                ) : step.detail && !step.done ? (
                  <span className="block text-xs text-shell-faint">{step.detail}</span>
                ) : null}
                {step.warning && !step.done ? (
                  <span className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
                    {step.warning}
                  </span>
                ) : null}
              </span>
              {step.howTo && !step.done ? (
                <HowToLink
                  path={step.howTo}
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-shell-accent hover:underline"
                >
                  <BookOpen size={12} aria-hidden />
                  How to
                </HowToLink>
              ) : null}
            </li>
          );
        })}
      </ul>
      {next ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={next.href}
            className="inline-flex items-center gap-1.5 rounded-md bg-shell-ink px-3.5 py-2 text-sm font-medium text-shell-side hover:opacity-90"
          >
            {next.label}
            <ArrowRight size={15} aria-hidden />
          </Link>
          {next.howTo ? (
            <HowToLink
              path={next.howTo}
              className="inline-flex items-center rounded-md border border-shell-line px-3.5 py-2 text-sm text-shell-ink hover:bg-shell-hover"
            >
              Read the guide
            </HowToLink>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FirstRun({ ideas }: { ideas: boolean }) {
  return (
    <section className={CARD}>
      <h2 className="text-base font-semibold">What are you building?</h2>
      <p className="mt-1 max-w-prose text-sm text-shell-muted">
        Tell Vizzy in a sentence below. It can draft a waitlist page, a welcome email and your brand voice. Nothing goes live
        until you publish it.
      </p>
      <Link
        href="/admin/launches/new"
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-shell-accent hover:underline"
      >
        Or create {ideaWord(ideas).a} by hand
        <ArrowRight size={15} aria-hidden />
      </Link>
    </section>
  );
}

function NeedsYou({ items, total }: { items: ReviewItem[]; total: number }) {
  return (
    <section className={CARD}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Needs you</h2>
        <Link href="/admin/approvals" className="text-xs font-medium text-shell-accent hover:underline">
          Open Review
        </Link>
      </div>
      {total === 0 ? (
        <p className="text-sm text-shell-muted">Nothing needs you right now.</p>
      ) : (
        <ul className="-mx-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={item.href} className="block rounded-md px-2 py-1.5 hover:bg-shell-hover">
                <span className="block text-sm text-shell-ink">{item.title}</span>
                <span className="block truncate text-xs text-shell-muted">{item.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > items.length ? (
        <p className="mt-1 text-xs text-shell-muted">and {total - items.length} more in Review</p>
      ) : null}
    </section>
  );
}

/**
 * Home with nav v2 phase 2: where the brand is on its growth path, the next step,
 * what needs a decision, this week's numbers (all real, "—" when unknown), and
 * Vizzy — the same conversation as the side panel on other pages. With ONBOARDING_ENABLED the
 * steps card is "Your next action", and lists the stage that fits what the brand told Vizzy
 * (src/lib/onboarding/homeOrder.ts). With NEXT_ACTION_CARD_ENABLED too, an admin of a brand that
 * told Vizzy about itself sees the card Vizzy wrote instead (src/lib/nextAction), drawn from the
 * kept card without waiting on the model, with the steps list until a card is there.
 */
export async function HomeV2() {
  const ctx = await requireAdminContext();
  const lifecycle = isLifecycleEnabled();
  const guide = isSetupGuideEnabled();
  const [signals, week, tenant, review] = await Promise.all([
    // The same reads Your next action hashes (homeSignalOptions), so Home and its route agree.
    loadGrowthSignals(ctx, homeSignalOptions()),
    loadWeekCounts(ctx, { lifecycle }),
    getTenantById(ctx.tenantId).catch(() => null),
    loadReview(ctx, { lifecycle, includeContent: false }).catch(() => ({ aiLines: 0, items: [] as ReviewItem[] })),
  ]);
  // A new brand's first admin meets Vizzy first. Home only redirects: the welcome marks itself shown
  // when it renders (markWelcomeShown), so a redirect lost to a racing refresh comes back on the next
  // visit to Home. redirect() throws, so never in a try.
  const onboarding = isOnboardingEnabled();
  if (onboarding && shouldWelcome(tenant, signals, ctx.role)) {
    redirect("/admin/welcome");
  }
  // Launches are called Ideas (worked out on the server): stage 2, its steps, the tile and the prompts.
  const ideas = isIdeaWordsEnabled();
  const growth = computeGrowth(signals, { ideas });
  const current = growth.stages.find((s) => s.key === growth.current) ?? null;
  const position = current ? growth.stages.indexOf(current) + 1 : 0;
  // Your next action: the card lists the stage that fits the brand's answers (no extra read: they
  // are on the brand record above). The track, the line under the title, the tiles and the prompts
  // keep the current stage. It is null only when every stage is done, as `current` is.
  const cardStage = onboarding ? nextActionStage(growth, tenant?.businessProfile?.answers) : current;

  const aiLines: ReviewItem[] = review.aiLines
    ? [
        {
          id: "ai-lines",
          kind: "ai_line",
          title: `${review.aiLines} AI line${review.aiLines === 1 ? "" : "s"} waiting for approval`,
          detail: "Undecided lines go out as the standard version",
          href: "/admin/approvals",
          action: "Review",
        },
      ]
    : [];
  const needs = [...aiLines, ...review.items];

  // Your next action as Vizzy's card: admins of a brand that told Vizzy about itself (the welcome
  // finished, or a fact kept). Members, a skipped welcome and a failed read keep the steps list.
  const next =
    onboarding && isNextActionCardEnabled() && ctx.role === "admin" && cardFits(tenant)
      ? await homeNextAction(ctx, { tenant, signals }).catch((err: unknown) => {
          console.warn("[home] Your next action didn't load:", err instanceof Error ? err.message.slice(0, 200) : "error");
          return null;
        })
      : null;
  const steps = (stage: StageView) => <NextSteps stage={stage} title={nextActionTitle(onboarding, stage)} />;

  return (
    <div className="flex min-h-[calc(100vh-6rem)] flex-col gap-6 text-shell-ink">
      <div>
        <p className={LABEL}>Home</p>
        <h1 className="mt-1 text-xl font-semibold">{tenant?.tenantName ?? "Welcome"}</h1>
        <p className="mt-0.5 text-sm text-shell-muted">
          {growth.firstRun
            ? "Let's get your idea in front of people."
            : current
              ? `Stage ${position} of ${growth.stages.length}: ${current.label}.`
              : "Every stage is running."}
        </p>
      </div>

      {growth.allRunning ? null : <GrowthTrack stages={growth.stages} />}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {next ? (
          // Vizzy's card, with the steps list as its fallback, and what needs a decision beside it.
          <>
            <NextActionCard initial={next.view} stale={next.stale}>
              {cardStage ? steps(cardStage) : null}
            </NextActionCard>
            <NeedsYou items={needs.slice(0, 3)} total={needs.length} />
          </>
        ) : guide && cardStage ? (
          // The setup guide: the next steps even on the first visit, with Vizzy's offer beside them.
          <>
            {steps(cardStage)}
            {growth.firstRun ? <FirstRun ideas={ideas} /> : <NeedsYou items={needs.slice(0, 3)} total={needs.length} />}
          </>
        ) : (
          <>
            {growth.firstRun ? (
              <FirstRun ideas={ideas} />
            ) : cardStage ? (
              steps(cardStage)
            ) : null}
            <NeedsYou items={needs.slice(0, 3)} total={needs.length} />
          </>
        )}
      </div>

      <section aria-labelledby="home-week">
        <h2 id="home-week" className={`${LABEL} mb-2`}>
          This week
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {homeTiles(growth.firstRun && !guide ? "launch" : growth.current, signals, week, new Date(), { ideas }).map((t) => (
            <div key={t.label} className="rounded-xl border border-shell-line bg-shell-card px-4 py-3">
              <p className="text-xs text-shell-muted">{t.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
              <p className="text-xs text-shell-faint">{t.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <AskChips prompts={homePrompts(growth.firstRun && !(guide && growth.current === "ready") ? "first" : growth.current, { ideas })} />
      <DashboardChat intro="compact" />
    </div>
  );
}
