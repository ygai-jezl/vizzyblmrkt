"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DECK_PRINT_CSS, PRINT_ROOT_ID, PRINT_SLIDE_CLASS } from "@/lib/raise/docs/print";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import type { DeckAudience, DeckStage, Slide } from "@/lib/raise/docs/types";
import { DeckFonts } from "./DeckFonts";
import { SlideView } from "./SlideView";

export interface PrintSlidesProps {
  slides: Slide[];
  theme: DeckTheme;
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  version: { n: number; at: string } | null;
  now?: Date;
}

/** Every slide at full size, one a page, with the print stylesheet. No hooks. */
export function PrintSlides({ slides, theme, title, audience, stage, version, now = new Date() }: PrintSlidesProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: DECK_PRINT_CSS }} />
      <DeckFonts theme={theme} />
      {slides.map((s, i) => (
        <div key={s.id} className={PRINT_SLIDE_CLASS}>
          <SlideView slide={s} theme={theme} n={i + 1} total={slides.length} title={title} audience={audience} stage={stage} mode="print" version={version} now={now} />
        </div>
      ))}
    </>
  );
}

/**
 * Save as PDF: puts every slide in a print root on document.body, waits for the fonts and logo,
 * then opens the browser's print window, where the person chooses Save as PDF. The root goes once
 * the print window closes.
 */
export function PrintDeck({ onDone, ...props }: PrintSlidesProps & { onDone: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    document.getElementById(PRINT_ROOT_ID)?.remove();
    const el = document.createElement("div");
    el.id = PRINT_ROOT_ID;
    document.body.appendChild(el);
    setHost(el);
    return () => el.remove();
  }, []);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    const after = () => onDone();
    window.addEventListener("afterprint", after);
    const t = window.setTimeout(async () => {
      try {
        await document.fonts?.ready;
        await Promise.all([...host.querySelectorAll("img")].map((img) => img.decode?.().catch(() => undefined)));
      } catch {
        // Print anyway: the browser falls back to the font stack.
      }
      if (!cancelled) window.print();
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.removeEventListener("afterprint", after);
    };
  }, [host, onDone]);

  return host ? createPortal(<PrintSlides {...props} />, host) : null;
}
