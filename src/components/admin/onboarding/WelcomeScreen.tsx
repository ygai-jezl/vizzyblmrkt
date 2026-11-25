"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ListChecks, Mic, Sparkles } from "lucide-react";
import { WELCOME_WORDS } from "@/lib/onboarding/words";
import { Orb, saveProfile, useOnboarding } from "./OnboardingFrame";

const QUESTIONS_HREF = "/admin/welcome/questions";

/**
 * The main choice's card. `yg-talk` gives it the turning gradient border with voice (globals.css);
 * without that style it is a plain card with a border.
 */
const PRIMARY =
  "yg-talk flex w-full items-center gap-3.5 rounded-[14px] border-2 border-shell-line bg-shell-card py-3.5 pl-3.5 pr-[18px] text-left text-shell-ink shadow-lg hover:bg-shell-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-shell-accent";
const PRIMARY_ICON = "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-shell-accent text-white";

/**
 * /admin/welcome, shown once per brand to the first admin who opens Home (and any time from
 * Settings). Talk with Vizzy by voice is the main choice when voice is on; without it, the
 * 4 quick questions are. Skip for now marks the profile skipped and goes to Home.
 *
 * `onTalk` starts the call. The call's own screens (the microphone, talking, the end) take this
 * one's place once it starts.
 */
export function WelcomeScreen({ onTalk }: { onTalk?: () => void }) {
  const { brand, voice } = useOnboarding();
  const router = useRouter();
  const [skipping, setSkipping] = useState(false);

  async function skip() {
    if (skipping) return;
    setSkipping(true);
    // Home again either way: a failed save leaves the profile started, which never redirects.
    await saveProfile({ status: "skipped", via: "welcome" });
    router.push("/admin");
  }

  return (
    <div className="flex w-full max-w-[480px] flex-col items-center text-center">
      <Orb>
        <Sparkles size={28} />
      </Orb>
      <h1 className="mt-5 text-balance text-[32px] font-semibold leading-10 tracking-[-0.02em]">{WELCOME_WORDS.title}</h1>
      <p className="mt-2 text-pretty text-base text-shell-muted">{WELCOME_WORDS.lead(brand.name)}</p>

      <div className="mt-8 flex w-full flex-col items-center">
        {voice ? (
          <>
            <button type="button" onClick={onTalk} className={PRIMARY}>
              <span className={PRIMARY_ICON}>
                <Mic size={20} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-base font-semibold">
                  {WELCOME_WORDS.talk}{" "}
                  <span className="ml-1 inline-block rounded-full bg-shell-accent-soft px-2 py-0.5 align-[2px] text-[11px] font-semibold leading-4 text-shell-accent">
                    {WELCOME_WORDS.fastest}
                  </span>
                </span>
                <span className="text-[13px] leading-[18px] text-shell-muted">{WELCOME_WORDS.talkSub}</span>
              </span>
              <ArrowRight size={18} aria-hidden className="shrink-0" />
            </button>
            <p className="mb-1 mt-2.5 flex items-start gap-2 text-left text-[13px] leading-[19px] text-shell-muted">
              <Sparkles size={14} aria-hidden className="mt-0.5 flex-none text-shell-accent" />
              {WELCOME_WORDS.talkHint}
            </p>
            <div className="mt-2 grid w-full">
              <Link
                href={QUESTIONS_HREF}
                className="flex items-center justify-center gap-2 rounded-xl border border-shell-line bg-shell-card px-3 py-[11px] text-sm font-medium text-shell-ink hover:bg-shell-hover"
              >
                <ListChecks size={16} aria-hidden className="text-shell-muted" />
                {WELCOME_WORDS.orQuestions}
              </Link>
            </div>
          </>
        ) : (
          <Link href={QUESTIONS_HREF} className={PRIMARY}>
            <span className={PRIMARY_ICON}>
              <ListChecks size={20} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-base font-semibold">{WELCOME_WORDS.questions}</span>
            <ArrowRight size={18} aria-hidden className="shrink-0" />
          </Link>
        )}
        <button
          type="button"
          onClick={skip}
          disabled={skipping}
          aria-busy={skipping || undefined}
          className="mt-[18px] text-sm text-shell-muted hover:text-shell-ink hover:underline disabled:cursor-wait"
        >
          {WELCOME_WORDS.skip}
        </button>
      </div>

      {voice ? <p className="mt-7 text-xs text-shell-faint">{WELCOME_WORDS.foot}</p> : null}
    </div>
  );
}
