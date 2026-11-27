import type { ComponentType } from "react";
import { SLIDE_SIZE } from "@/lib/raise/docs/layouts";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { dayWords } from "@/lib/raise/docs/text";
import type { DeckAudience, DeckStage, LayoutKey, Slide } from "@/lib/raise/docs/types";
import { STUDIO_WORDS, needCallout } from "@/lib/raise/docs/words";
import { Ask } from "./layouts/Ask";
import { BigNumber } from "./layouts/BigNumber";
import { Chart } from "./layouts/Chart";
import { Compare } from "./layouts/Compare";
import { Cover } from "./layouts/Cover";
import { bodyStyle, type LayoutProps, type SlideMode } from "./layouts/parts";
import { Statement } from "./layouts/Statement";
import { Team } from "./layouts/Team";
import { ThreePoints } from "./layouts/ThreePoints";

export type { SlideMode };

const LAYOUT: Record<LayoutKey, ComponentType<LayoutProps>> = {
  cover: Cover,
  statement: Statement,
  three_points: ThreePoints,
  big_number: BigNumber,
  chart: Chart,
  compare: Compare,
  team: Team,
  ask: Ask,
};

export interface SlideViewProps {
  slide: Slide;
  theme: DeckTheme;
  /** 1 based. */
  n: number;
  total: number;
  /** The deck's name. */
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  mode: SlideMode;
  /** The version shown, for the last slide's footer ("Version 4, 26 Nov"). */
  version?: { n: number; at: string } | null;
  now?: Date;
  /** The studio only: Dismiss on a Needs callout. */
  onDismissNeed?: (needId: string) => void;
}

/**
 * One slide at 1280 by 720 CSS pixels, in the deck's look: the logo in the corner, the layout, and on
 * the last slide only a small footer with the version and its date. Needs callouts show in the
 * studio only, never in Present, the PDF or a thumbnail. No hooks, so it renders anywhere (the
 * print root, tests).
 */
export function SlideView({ slide, theme, n, total, title, audience, stage, mode, version, now = new Date(), onDismissNeed }: SlideViewProps) {
  const Layout = LAYOUT[slide.layout] ?? Statement;
  const last = n === total;
  return (
    <div
      data-slide={n}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: SLIDE_SIZE.width,
        height: SLIDE_SIZE.height,
        padding: "72px 88px 64px",
        boxSizing: "border-box",
        overflow: "hidden",
        background: theme.ground,
        color: theme.ink,
        fontFamily: theme.bodyFont,
        textAlign: "left",
      }}
    >
      {slide.layout !== "cover" ? <Corner theme={theme} /> : null}
      <Layout slide={slide} theme={theme} title={title} audience={audience} stage={stage} mode={mode} now={now} />
      {last && version ? (
        <span style={{ ...bodyStyle(theme, 14, true), position: "absolute", left: 88, bottom: 26 }}>{STUDIO_WORDS.footer(version.n, dayWords(version.at, now))}</span>
      ) : null}
      {mode === "edit" && slide.needs.length ? (
        <div style={{ position: "absolute", left: 88, right: 88, bottom: 56, display: "flex", flexDirection: "column", gap: 10 }}>
          {slide.needs.map((need) => (
            <div
              key={need.id}
              data-need={need.id}
              style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 18px", borderRadius: 10, background: "#FEF3C7", border: "2px solid #F59E0B" }}
            >
              <span style={{ ...bodyStyle(theme, 20), color: "#78350F" }}>{needCallout(need.text)}</span>
              {onDismissNeed ? (
                <button
                  type="button"
                  onClick={() => onDismissNeed(need.id)}
                  style={{ ...bodyStyle(theme, 18), color: "#78350F", background: "transparent", border: "1px solid #B45309", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
                >
                  {STUDIO_WORDS.dismiss}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The logo small in the top right corner, or the brand's name in the heading font. */
function Corner({ theme }: { theme: DeckTheme }) {
  const box = { position: "absolute", top: 32, right: 40, display: "flex" } as const;
  if (theme.logoUrl) {
    return (
      <div style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={theme.logoUrl} alt={theme.brandName} style={{ height: 34, maxWidth: 180, objectFit: "contain" }} />
      </div>
    );
  }
  if (!theme.brandName) return null;
  return <span style={{ ...box, fontFamily: theme.headingFont, fontSize: 18, fontWeight: 700, color: theme.muted }}>{theme.brandName}</span>;
}
