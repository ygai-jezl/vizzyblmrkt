"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HINT_MS, deckTarget, presentAction, slideTargets, stepTo, timerLines } from "@/lib/raise/docs/present";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { renderText } from "@/lib/raise/docs/text";
import type { DeckAudience, DeckStage, Slide } from "@/lib/raise/docs/types";
import { PRESENT_WORDS } from "@/lib/raise/docs/words";
import { DeckFonts } from "./DeckFonts";
import { FitSlide } from "./SlideFrame";
import { SlideView } from "./SlideView";

export interface PresentViewProps {
  slides: Slide[];
  theme: DeckTheme;
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  version: { n: number; at: string } | null;
  /** How long each slide's notes take to say, in seconds. */
  perSlideSeconds: number[];
  /** The slide to start on, 0 based. */
  start: number;
  /** Rehearse: the notes and the timer are on from the start. */
  rehearse: boolean;
  onClose: () => void;
}

const CONTROL = "rounded-md border border-white/30 px-3 py-1.5 text-sm text-white hover:bg-white/10";

/**
 * Present: the deck full screen, one slide at a time, with the speaker notes and a timer when asked
 * for (N), or from the start in Rehearse. Needs callouts and check dots never show here. If the
 * browser refuses full screen, it fills the window instead.
 */
export function PresentView({ slides, theme, title, audience, stage, version, perSlideSeconds, start, rehearse, onClose }: PresentViewProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(slides.length - 1, start)));
  const [notes, setNotes] = useState(rehearse);
  const [hint, setHint] = useState(true);
  const [deckStart, setDeckStart] = useState(() => Date.now());
  const [slideStart, setSlideStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [today] = useState(() => new Date());
  const targets = slideTargets(perSlideSeconds);
  const slide = slides[index] ?? slides[0]!;

  const go = useCallback(
    (action: "next" | "back" | "first" | "last") => {
      const next = stepTo(index, slides.length, action);
      if (next === index) return;
      setIndex(next);
      setSlideStart(Date.now());
    },
    [index, slides.length],
  );
  const restart = useCallback(() => {
    const t = Date.now();
    setDeckStart(t);
    setSlideStart(t);
    setNow(t);
  }, []);

  // Full screen when the browser allows it; leaving full screen (the browser's own Esc) leaves Present.
  useEffect(() => {
    const el = root.current;
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) onClose();
    };
    document.addEventListener("fullscreenchange", onChange);
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = presentAction(e.key);
      if (!action) return;
      e.preventDefault();
      if (action === "leave") onClose();
      else if (action === "notes") setNotes((n) => !n);
      else if (action === "timer") restart();
      else go(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, restart]);

  useEffect(() => {
    const t = window.setTimeout(() => setHint(false), HINT_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!notes) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [notes]);

  const timer = timerLines({
    slideElapsed: (now - slideStart) / 1000,
    slideTarget: targets[index] ?? 0,
    totalElapsed: (now - deckStart) / 1000,
    totalTarget: deckTarget(targets),
  });
  const said = renderText(slide.notes, slide.blocks).trim();

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[60] flex flex-col bg-neutral-950 text-white">
      <DeckFonts theme={theme} />
      <div className="relative min-h-0 flex-1 p-4">
        <FitSlide fitHeight>
          <SlideView slide={slide} theme={theme} n={index + 1} total={slides.length} title={title} audience={audience} stage={stage} mode="present" version={version} now={today} />
        </FitSlide>
        {hint ? (
          <p role="status" className="pointer-events-none absolute inset-x-0 bottom-6 mx-auto w-fit rounded-md bg-black/70 px-4 py-2 text-sm">
            {PRESENT_WORDS.hint}
          </p>
        ) : null}
      </div>
      {notes ? (
        <div className="max-h-[30vh] overflow-y-auto border-t border-white/15 px-6 py-3">
          <p className="whitespace-pre-wrap text-base leading-relaxed">{said || PRESENT_WORDS.noNotes}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/15 px-4 py-2 text-sm">
        <span className="text-white/70">{PRESENT_WORDS.slideOf(index + 1, slides.length)}</span>
        {notes ? (
          <>
            <span data-over={timer.over ? "true" : undefined} className={timer.over ? "font-semibold text-amber-400" : "text-white/90"}>
              {timer.slide}
            </span>
            <span className="text-white/70">{timer.total}</span>
          </>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" className={CONTROL} onClick={() => go("back")} disabled={index === 0}>
            {PRESENT_WORDS.back}
          </button>
          <button type="button" className={CONTROL} onClick={() => go("next")} disabled={index === slides.length - 1}>
            {PRESENT_WORDS.next}
          </button>
          <button type="button" className={CONTROL} aria-pressed={notes} onClick={() => setNotes((n) => !n)}>
            {PRESENT_WORDS.notes}
          </button>
          {notes ? (
            <button type="button" className={CONTROL} onClick={restart}>
              {PRESENT_WORDS.restart}
            </button>
          ) : null}
          <button type="button" className={CONTROL} onClick={onClose}>
            {PRESENT_WORDS.leave}
          </button>
        </span>
      </div>
    </div>
  );
}
