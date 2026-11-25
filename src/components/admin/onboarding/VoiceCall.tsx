"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Loader2, Mic, MicOff, Sparkles, Square } from "lucide-react";
import { VOICE_WORDS, WELCOME_WORDS, longLength } from "@/lib/onboarding/words";
import { heardLabels, type TopicState, type TopicView } from "@/lib/onboarding/voice/topics";
import { cleanText, clock, type LiveLine } from "@/lib/onboarding/voice/transcript";
import type { VoiceCall as VoiceCallState, VoiceProblem } from "@/lib/onboarding/voice/useVoiceCall";
import { Orb, useFrameTopSlot } from "./OnboardingFrame";

const QUESTIONS_HREF = "/admin/welcome/questions";
/** Finished lines kept on screen (the oldest fade out at the top). */
const LINES_SHOWN = 12;

const H1 = "mt-5 text-balance text-[32px] font-semibold leading-10 tracking-[-0.02em] outline-none";
const LEAD = "mt-2 text-pretty text-base text-shell-muted";
const FOOT = "mt-7 text-xs text-shell-faint";
const CHIP = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] leading-[18px]";
const CHIP_LOOK: Record<TopicState, string> = {
  done: "border-transparent bg-shell-accent-soft text-shell-ink",
  now: "border-solid border-shell-accent text-shell-ink",
  next: "border-dashed border-shell-faint text-shell-muted",
};

const PROBLEM_WORDS: Record<VoiceProblem, string> = {
  blocked: VOICE_WORDS.blocked,
  used_today: VOICE_WORDS.usedToday,
  full: VOICE_WORDS.full,
  unavailable: VOICE_WORDS.unavailable,
};

/** Focus the screen's heading when it appears, so a screen reader starts there. */
function useFocusOnShow() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/**
 * Talk with Vizzy's own screens on the welcome (Welcome.html): the microphone, the call and its
 * end. The welcome shows them once Talk with Vizzy is chosen.
 */
export function VoiceCall({ call }: { call: VoiceCallState }) {
  if (call.phase === "mic") return <MicrophoneScreen problem={call.problem} />;
  if (call.phase === "talking") return <TalkingScreen call={call} />;
  if (call.phase === "ended" && call.ended) return <EndedScreen ended={call.ended} />;
  return null;
}

/**
 * Allow your microphone: the browser's own prompt does the asking. A call that can't start says
 * why here, with the 4 quick questions as the way on.
 */
export function MicrophoneScreen({ problem }: { problem: VoiceProblem | null }) {
  const heading = useFocusOnShow();
  return (
    <div className="flex w-full max-w-[480px] flex-col items-center text-center">
      <Orb look="wait">
        <Mic size={28} />
      </Orb>
      <h1 ref={heading} tabIndex={-1} className={H1}>
        {problem && problem !== "blocked" ? WELCOME_WORDS.talk : VOICE_WORDS.micTitle}
      </h1>
      {problem ? (
        <p role="alert" className={LEAD}>
          {PROBLEM_WORDS[problem]}
        </p>
      ) : (
        <p className={LEAD}>{VOICE_WORDS.micLead}</p>
      )}
      {/* Whole page loads out of the welcome's document, which allows the microphone. */}
      <a href={QUESTIONS_HREF} className="mt-[18px] text-sm text-shell-muted hover:text-shell-ink hover:underline">
        {VOICE_WORDS.instead}
      </a>
      <p className={FOOT}>{VOICE_WORDS.micFoot}</p>
    </div>
  );
}

/** Live and the time left, on the top bar's right. */
export function LiveClock({ left, total }: { left: number; total: number }) {
  const shown = clock(left);
  const share = total > 0 ? Math.round(Math.max(0, Math.min(100, (left / total) * 100))) : 0;
  return (
    <>
      <span className="inline-flex items-center gap-1.5 font-semibold text-shell-ink">
        <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--ob-live)] shadow-[0_0_0_3px_var(--ob-live-ring)]" />
        {VOICE_WORDS.live}
      </span>
      <span role="timer" aria-label={VOICE_WORDS.leftAria(shown)} className="inline-flex items-center gap-2 tabular-nums">
        <span aria-hidden className="block h-1 w-24 overflow-hidden rounded-full bg-shell-line">
          <span className="block h-full rounded-full bg-shell-ink" style={{ width: `${share}%` }} />
        </span>
        {VOICE_WORDS.left(shown)}
      </span>
    </>
  );
}

/** The four topics, ticked as Vizzy notes them. */
export function TopicChips({ topics }: { topics: TopicView[] }) {
  return (
    <ul aria-label={VOICE_WORDS.topics} className="mt-5 flex flex-wrap justify-center gap-2">
      {topics.map((t) => (
        <li key={t.key} className={`${CHIP} ${CHIP_LOOK[t.state]}`}>
          {t.state === "done" ? <Check size={14} aria-hidden className="text-shell-accent" /> : null}
          {t.label}
          {t.state === "done" ? <span className="sr-only">{VOICE_WORDS.covered(t.answer)}</span> : null}
          {t.state === "now" ? <span className="sr-only">{VOICE_WORDS.now}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Line({ line, live = false }: { line: LiveLine; live?: boolean }) {
  const vizzy = line.who === "vizzy";
  const Tag = live ? "div" : "li";
  return (
    <Tag className="flex gap-3.5 text-[15px] leading-[22px]">
      <span className={`w-11 shrink-0 text-xs font-semibold leading-[22px] ${vizzy ? "text-shell-accent" : "text-shell-faint"}`}>
        {vizzy ? VOICE_WORDS.vizzy : VOICE_WORDS.you}
      </span>
      <span className={`min-w-0 break-words ${vizzy ? "text-shell-muted" : "text-shell-ink"}${live ? " yg-caret" : ""}`}>{cleanText(line.text)}</span>
    </Tag>
  );
}

/**
 * The call: what Vizzy makes sure it covers, the live transcript, Mute and End. Only finished
 * lines are in the live region; the line still being heard sits after it, so a screen reader
 * hears each line once, whole.
 */
export function TalkingScreen({ call }: { call: Pick<VoiceCallState, "muted" | "secondsLeft" | "callSeconds" | "topics" | "transcript" | "toggleMute" | "end"> }) {
  const slot = useFrameTopSlot();
  const heading = useFocusOnShow();
  const { lines, partial } = call.transcript;
  const first = Math.max(0, lines.length - LINES_SHOWN);
  const round = "grid h-12 w-12 place-items-center rounded-full border border-shell-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shell-accent";
  return (
    <div className="flex w-full max-w-[680px] flex-col items-center text-center">
      {slot ? createPortal(<LiveClock left={call.secondsLeft} total={call.callSeconds} />, slot) : null}
      <h1 ref={heading} tabIndex={-1} className="sr-only">
        {WELCOME_WORDS.talk}
      </h1>
      <Orb look="live" small>
        <Sparkles size={26} />
      </Orb>
      <p className="mt-2 text-sm font-medium text-shell-muted">{call.muted ? VOICE_WORDS.muted : VOICE_WORDS.listening}</p>
      <TopicChips topics={call.topics} />
      <div className="mt-6 w-full rounded-2xl border border-shell-line bg-shell-card px-6 py-5 text-left">
        <div className="flex max-h-[300px] flex-col justify-end gap-3.5 overflow-hidden [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_40px)] [mask-image:linear-gradient(to_bottom,transparent_0,#000_40px)]">
          <ol aria-live="polite" aria-label={VOICE_WORDS.transcript} className="flex flex-col gap-3.5">
            {lines.slice(first).map((line, i) => (
              <Line key={first + i} line={line} />
            ))}
          </ol>
          {partial && cleanText(partial.text) ? <Line line={partial} live /> : null}
        </div>
      </div>
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          aria-label={VOICE_WORDS.mute}
          aria-pressed={call.muted}
          onClick={call.toggleMute}
          className={`${round} ${call.muted ? "bg-shell-ink text-shell-side" : "bg-shell-card text-shell-ink hover:bg-shell-hover"}`}
        >
          {call.muted ? <MicOff size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
        </button>
        <button
          type="button"
          onClick={call.end}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-[var(--ob-end)] px-[22px] text-[15px] font-semibold leading-[22px] text-white hover:bg-[var(--ob-end-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shell-accent"
        >
          <Square size={18} aria-hidden fill="currentColor" />
          {VOICE_WORDS.end}
        </button>
      </div>
      <p className={FOOT}>{VOICE_WORDS.talkFoot}</p>
    </div>
  );
}

/**
 * Thanks, that's plenty: how long it was, what Vizzy heard, and See what I learned, which waits
 * (busy) while the server learns from the call.
 */
export function EndedScreen({ ended }: { ended: NonNullable<VoiceCallState["ended"]> }) {
  const heading = useFocusOnShow();
  const heard = heardLabels(ended.heard);
  const length = longLength(ended.seconds);
  const href = `/admin/welcome/learned?c=${encodeURIComponent(ended.conversationId)}`;
  const wait = (e: MouseEvent) => {
    if (ended.learning) e.preventDefault();
  };
  return (
    <div className="flex w-full max-w-[680px] flex-col items-center text-center">
      <Orb done>
        <Check size={30} />
      </Orb>
      <h1 ref={heading} tabIndex={-1} className={H1}>
        {VOICE_WORDS.endedTitle}
      </h1>
      <p className={LEAD}>{heard.length === 4 ? VOICE_WORDS.allCovered(length) : VOICE_WORDS.someCovered(length, heard.length)}</p>
      {ended.dropped ? (
        <p role="status" className="mt-2 text-sm text-shell-muted">
          {VOICE_WORDS.dropped}
        </p>
      ) : null}
      {heard.length ? (
        <ul aria-label={VOICE_WORDS.heard} className="mt-5 flex flex-wrap justify-center gap-2">
          {heard.map((h) => (
            <li key={h.key} className={`${CHIP} ${CHIP_LOOK.done}`}>
              <Check size={14} aria-hidden className="text-shell-accent" />
              {h.label}
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href={href}
        onClick={wait}
        aria-busy={ended.learning || undefined}
        aria-disabled={ended.learning || undefined}
        className={`yg-talk mt-7 inline-flex items-center justify-center gap-2 rounded-[14px] border-2 px-[22px] py-3 text-[15px] font-semibold leading-[22px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-shell-accent${
          ended.learning ? " cursor-wait" : ""
        }`}
      >
        {ended.learning ? <Loader2 size={18} aria-hidden className="animate-spin" /> : null}
        {VOICE_WORDS.seeLearned}
        {ended.learning ? null : <ArrowRight size={18} aria-hidden />}
      </a>
      <p className={FOOT}>{VOICE_WORDS.endedFoot}</p>
    </div>
  );
}
