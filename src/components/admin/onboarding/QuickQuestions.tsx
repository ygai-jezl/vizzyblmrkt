"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  ClipboardList,
  Handshake,
  Lightbulb,
  MapPin,
  Megaphone,
  Rocket,
  Store,
  TrendingUp,
  User,
  Users,
  type LucideProps,
} from "lucide-react";
import { QUESTIONS_WORDS } from "@/lib/onboarding/words";
import { finishBody, optionForKey, pick, questionsView } from "@/lib/onboarding/quickQuestions";
import type { ProfileAnswers } from "@/lib/types/businessProfile";
import { Orb, saveProfile, useOnboarding } from "./OnboardingFrame";

/** Each answer's picture, as the mockups draw them. */
const ICONS: Record<string, ComponentType<LucideProps>> = {
  solo: User,
  team: Users,
  agency: Briefcase,
  app: AppWindow,
  shop: Store,
  service: MapPin,
  idea: Lightbulb,
  launched: Rocket,
  established: TrendingUp,
  waitlist: ClipboardList,
  audience: Megaphone,
  customers: Handshake,
};

const LINK =
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink";
const TOPIC = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] leading-[18px]";

type Final = "idle" | "saving" | "saved" | "failed";

/**
 * /admin/welcome/questions: one question at a time, three answers each, and a pick moves straight
 * on. Each pick saves at once, so a closed tab keeps what was picked. The keys 1 to 3 pick too.
 * Back and Skip move between them; after the fourth, a short summary saves done and links Home.
 */
export function QuickQuestions() {
  const { answers, voice } = useOnboarding();
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<ProfileAnswers>(answers);
  const [final, setFinal] = useState<Final>("idle");
  const heading = useRef<HTMLHeadingElement>(null);
  const view = questionsView(at, picked);

  const choose = useCallback(
    (index: number) => {
      const next = pick(at, picked, index);
      if (!next) return;
      setPicked(next.picked);
      setAt(next.at);
      if (next.save) void saveProfile({ answers: next.save, via: "questions" });
    },
    [at, picked],
  );

  const finish = useCallback(async (all: ProfileAnswers) => {
    setFinal("saving");
    setFinal((await saveProfile(finishBody(all))) ? "saved" : "failed");
  }, []);

  // The summary saves every answer with done, once.
  const finished = useRef(false);
  useEffect(() => {
    if (!view.done || finished.current) return;
    finished.current = true;
    void finish(picked);
  }, [view.done, finish, picked]);

  // Each new question (and the summary) is read from its heading.
  useEffect(() => {
    heading.current?.focus();
  }, [at]);

  useEffect(() => {
    if (view.done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const index = optionForKey(e.key);
      if (index === null) return;
      e.preventDefault();
      choose(index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.done, choose]);

  if (view.done) {
    return (
      <div className="flex w-full max-w-[680px] flex-col items-center text-center">
        <Orb done>
          <Check size={30} />
        </Orb>
        <h1 ref={heading} tabIndex={-1} className="mt-5 text-balance text-[32px] font-semibold leading-10 tracking-[-0.02em] outline-none">
          {QUESTIONS_WORDS.done}
        </h1>
        <ul aria-label={QUESTIONS_WORDS.yourAnswers} className="mt-5 flex flex-wrap justify-center gap-2">
          {view.summary.map((s) => (
            <li
              key={s.label}
              className={`${TOPIC} ${s.answered ? "border-transparent bg-shell-accent-soft text-shell-ink" : "border-dashed border-shell-faint text-shell-muted"}`}
            >
              {s.label}
            </li>
          ))}
        </ul>
        <Link
          href="/admin"
          className="yg-talk mt-7 inline-flex items-center justify-center gap-3.5 rounded-[14px] border-2 border-shell-line bg-shell-card px-[22px] py-3 text-[15px] font-semibold leading-[22px] text-shell-ink shadow-lg hover:bg-shell-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-shell-accent"
        >
          {QUESTIONS_WORDS.next}
          <ArrowRight size={18} aria-hidden />
        </Link>
        {final === "failed" ? (
          <p role="alert" className="mt-4 text-sm text-shell-ink">
            {QUESTIONS_WORDS.notSaved}{" "}
            <button type="button" onClick={() => void finish(picked)} className="font-medium text-shell-accent hover:underline">
              {QUESTIONS_WORDS.retry}
            </button>
          </p>
        ) : null}
        {voice ? <p className="mt-7 text-xs text-shell-faint">{QUESTIONS_WORDS.foot}</p> : null}
      </div>
    );
  }

  const q = view.question;
  return (
    <div className="w-full max-w-[760px]">
      <div className="flex items-center gap-3.5 text-[13px] font-medium leading-[18px] tabular-nums text-shell-muted">
        <span>{view.progress}</span>
        <ol aria-hidden className="grid flex-1 grid-cols-4 gap-1.5">
          {view.segments.map((s, i) => (
            <li key={i} className={`h-1 rounded-full ${s === "done" ? "bg-shell-ink" : s === "now" ? "bg-shell-accent" : "bg-shell-line"}`} />
          ))}
        </ol>
      </div>
      {view.soFar.length ? (
        <ul aria-label={QUESTIONS_WORDS.soFar} className="mt-3.5 flex flex-wrap gap-1.5">
          {view.soFar.map((label) => (
            <li key={label} className="inline-flex items-center gap-[5px] rounded-full bg-shell-active px-2.5 py-[3px] text-xs text-shell-muted">
              <Check size={12} aria-hidden />
              {label}
            </li>
          ))}
        </ul>
      ) : null}
      <h1 id="ob-q" ref={heading} tabIndex={-1} className="mt-10 text-[32px] font-semibold leading-10 tracking-[-0.02em] outline-none">
        {q.q}
      </h1>
      <p className="mt-1.5 text-[15px] leading-[22px] text-shell-muted">{QUESTIONS_WORDS.pickOne}</p>
      <div role="group" aria-labelledby="ob-q" className="mt-7 grid gap-3 sm:grid-cols-3">
        {q.options.map((o, i) => {
          const Icon = ICONS[o.key] ?? Check;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => choose(i)}
              className="flex min-h-[152px] flex-col gap-4 rounded-2xl border border-shell-line bg-shell-card p-5 text-left transition-[border-color,box-shadow] duration-150 hover:border-shell-ink hover:shadow-lg focus-visible:border-shell-ink focus-visible:shadow-lg focus-visible:outline-none"
            >
              <span className="flex items-start justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-shell-accent-soft text-shell-accent">
                  <Icon size={22} aria-hidden />
                </span>
                <kbd aria-hidden className="rounded border border-shell-line px-1.5 font-sans text-[11px] leading-[18px] text-shell-faint">
                  {i + 1}
                </kbd>
              </span>
              <span className="mt-auto text-[17px] font-semibold leading-6 text-shell-ink">{o.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-7 flex items-center justify-between">
        {view.backToWelcome ? (
          // A whole page load, so the welcome gets its own page settings (the microphone).
          <a href="/admin/welcome" className={LINK}>
            <ArrowLeft size={16} aria-hidden />
            {QUESTIONS_WORDS.back}
          </a>
        ) : (
          <button type="button" onClick={() => setAt(at - 1)} className={LINK}>
            <ArrowLeft size={16} aria-hidden />
            {QUESTIONS_WORDS.back}
          </button>
        )}
        <button type="button" onClick={() => setAt(at + 1)} className={LINK}>
          {QUESTIONS_WORDS.skip}
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
