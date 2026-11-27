"use client";

import { useState } from "react";
import type { Check } from "@/lib/raise/docs/checks";
import { guidanceFor } from "@/lib/raise/docs/outlines";
import { talkTime } from "@/lib/raise/docs/text";
import type { DeckAudience, PackLine, Slide } from "@/lib/raise/docs/types";
import { CHECKS_TAB, SLIDE_RULES, SOURCE_LABEL_WORDS, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { blockLabel } from "./layouts/parts";

export type SideTab = "slide" | "sources" | "checks" | "talk";
export const SIDE_TABS: SideTab[] = ["slide", "sources", "checks", "talk"];

export interface SideTabsProps {
  slide: Slide;
  audience: DeckAudience;
  checks: Check[];
  sources: PackLine[];
  talk: { slide: { words: number; seconds: number }; deck: { words: number; seconds: number } };
  now: Date;
  /** Opens Present with the notes and the timer on. */
  onRehearse?: () => void;
  /** The tab open first. */
  initial?: SideTab;
}

/** The tabs beside the slide: This slide, Sources, Checks and Talk track. */
export function SideTabs({ initial = "slide", ...rest }: SideTabsProps) {
  const [tab, setTab] = useState<SideTab>(initial);
  return (
    <div className="space-y-3">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {SIDE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-2 py-1.5 text-sm ${tab === t ? "border-neutral-900 font-medium dark:border-white" : "border-transparent text-neutral-500"}`}
          >
            {STUDIO_WORDS.tabs[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <TabBody tab={tab} {...rest} />
      </div>
    </div>
  );
}

/** One tab's body. No hooks. */
export function TabBody({ tab, slide, audience, checks, sources, talk, now, onRehearse }: Omit<SideTabsProps, "initial"> & { tab: SideTab }) {
  if (tab === "slide") {
    return (
      <ul className="space-y-2 text-sm">
        <li>{guidanceFor(slide.section, audience)}</li>
        {SLIDE_RULES.map((r) => (
          <li key={r} className="text-neutral-600 dark:text-neutral-400">
            {r}
          </li>
        ))}
      </ul>
    );
  }
  if (tab === "sources") {
    const lines = slide.sources.map((id) => sources.find((s) => s.id === id)).filter((s): s is PackLine => Boolean(s));
    if (!lines.length && !slide.blocks.length) return <p className="text-sm text-neutral-500">{STUDIO_WORDS.sourcesEmpty}</p>;
    return (
      <ul className="space-y-3 text-sm">
        {lines.map((l) => (
          <li key={l.id} className="space-y-0.5">
            <span className="block text-xs font-medium text-neutral-500">{SOURCE_LABEL_WORDS[l.label]}</span>
            {l.url && /^https?:\/\//.test(l.url) ? (
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline dark:text-blue-300">
                {l.text}
              </a>
            ) : (
              <span>{l.text}</span>
            )}
          </li>
        ))}
        {slide.blocks.map((b) => (
          <li key={b.id} className="space-y-0.5">
            <span className="block text-xs font-medium text-neutral-500">{blockLabel(b, now)}</span>
            <span>
              {b.name}
              {b.display ? `: ${b.display}` : ""}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (tab === "checks") {
    const own = checks.filter((c) => c.slideId === slide.id);
    const deck = checks.filter((c) => c.slideId === null);
    return (
      <div className="space-y-3 text-sm">
        {own.length ? (
          <ul className="space-y-2">
            {own.map((c, i) => (
              <li key={`${c.code}${i}`} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                {c.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-500">{CHECKS_TAB.empty}</p>
        )}
        {deck.length ? (
          <div className="space-y-2">
            <span className="block text-xs font-medium text-neutral-500">{CHECKS_TAB.deck}</span>
            <ul className="space-y-2">
              {deck.map((c, i) => (
                <li key={`${c.code}${i}`} className="rounded-md border border-neutral-300 p-2 dark:border-neutral-700">
                  {c.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-neutral-500">{CHECKS_TAB.line}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p>{STUDIO_WORDS.talkLine}</p>
      <p className="text-neutral-600 dark:text-neutral-400">{STUDIO_WORDS.talkSlide(talk.slide.words, talkTime(talk.slide.seconds))}</p>
      <p className="text-neutral-600 dark:text-neutral-400">{STUDIO_WORDS.talkDeck(talk.deck.words, talkTime(talk.deck.seconds))}</p>
      {onRehearse ? (
        <button type="button" onClick={onRehearse} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
          {STUDIO_WORDS.rehearse}
        </button>
      ) : null}
    </div>
  );
}
