"use client";

import { useState } from "react";
import type { Check } from "@/lib/raise/docs/checks";
import { SECTIONS_FOR } from "@/lib/raise/docs/outlines";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { RAISE_DOC_LIMITS as L, type DeckAudience, type DeckStage, type SectionKey, type Slide } from "@/lib/raise/docs/types";
import { SECTION_LABEL, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { SlideFrame } from "./SlideFrame";
import { SlideView } from "./SlideView";

const THUMB = 168 / 1280;
const ACTION = "rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700";

export interface SlideRailProps {
  slides: Slide[];
  index: number;
  checks: Check[];
  theme: DeckTheme;
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  canEdit: boolean;
  now: Date;
  onSelect: (i: number) => void;
  onAdd: (section: SectionKey) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

/** The slides as thumbnails, a dot on each slide with checks, and for admins Add slide, Move up, Move down and Remove slide. */
export function SlideRail({ slides, index, checks, theme, title, audience, stage, canEdit, now, onSelect, onAdd, onMove, onRemove }: SlideRailProps) {
  const [adding, setAdding] = useState(false);
  return (
    <nav aria-label="Slides" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {slides.map((s, i) => {
          const n = checks.filter((c) => c.slideId === s.id).length;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={i === index ? "true" : undefined}
                className={`relative block rounded-md border-2 text-left ${i === index ? "border-blue-600" : "border-transparent hover:border-neutral-300 dark:hover:border-neutral-700"}`}
              >
                <span className="block px-1 pt-1 text-xs text-neutral-500">{STUDIO_WORDS.slideN(i + 1)}</span>
                <SlideFrame scale={THUMB} className="m-1 rounded-sm border border-neutral-200 dark:border-neutral-800">
                  <SlideView slide={s} theme={theme} n={i + 1} total={slides.length} title={title} audience={audience} stage={stage} mode="thumb" now={now} />
                </SlideFrame>
                {n ? <span title={STUDIO_WORDS.checksDot(n)} aria-label={STUDIO_WORDS.checksDot(n)} className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-amber-500" /> : null}
              </button>
            </li>
          );
        })}
      </ol>
      {canEdit ? (
        <div className="flex flex-wrap gap-1">
          <div className="relative">
            <button type="button" className={ACTION} disabled={slides.length >= L.slides} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              {STUDIO_WORDS.addSlide}
            </button>
            {adding ? (
              <ul role="menu" className="absolute left-0 top-full z-20 mt-1 w-48 rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
                {SECTIONS_FOR[audience].map((section) => (
                  <li key={section}>
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                      onClick={() => {
                        setAdding(false);
                        onAdd(section);
                      }}
                    >
                      {SECTION_LABEL[section]}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button type="button" className={ACTION} disabled={index <= 0} onClick={() => onMove(-1)}>
            {STUDIO_WORDS.moveUp}
          </button>
          <button type="button" className={ACTION} disabled={index >= slides.length - 1} onClick={() => onMove(1)}>
            {STUDIO_WORDS.moveDown}
          </button>
          <button type="button" className={ACTION} disabled={slides.length <= L.minSlides} onClick={onRemove}>
            {STUDIO_WORDS.removeSlide}
          </button>
        </div>
      ) : null}
    </nav>
  );
}
