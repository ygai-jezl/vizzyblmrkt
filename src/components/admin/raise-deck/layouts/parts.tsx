import type { CSSProperties, ReactNode } from "react";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { isPending } from "@/lib/raise/docs/edit";
import { labelWords, renderText } from "@/lib/raise/docs/text";
import type { DeckAudience, DeckStage, MetricBlock, Slide } from "@/lib/raise/docs/types";
import { LABEL_WORDS } from "@/lib/raise/docs/words";

/**
 * What every slide layout shares: the props, the headline, points and big numbers, drawn at 1280
 * by 720 CSS pixels in the deck's look (theme tokens only, flexbox only, real text). No hooks.
 */

/** Where a slide is drawn: the studio (Needs show), Present, the print root or a thumbnail. */
export type SlideMode = "edit" | "present" | "print" | "thumb";

export interface LayoutProps {
  slide: Slide;
  theme: DeckTheme;
  /** The deck's name, for the cover when its headline is empty. */
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  mode: SlideMode;
  now: Date;
}

/** The slide's text with its numbers in. */
export const said = (slide: Slide, text: string) => renderText(text, slide.blocks).trim();

/** The blocks a slide shows: a number not filled yet shows only in the studio. */
export function shownBlocks(slide: Slide, mode: SlideMode): MetricBlock[] {
  return slide.blocks.filter((b) => b.value !== null || (mode === "edit" && isPending(b)));
}

export const isSeriesBlock = (b: MetricBlock) => (b.grain === "week" || b.grain === "month") && (b.series?.length ?? 0) > 1;

export function headingStyle(theme: DeckTheme, size: number): CSSProperties {
  return { fontFamily: theme.headingFont, fontSize: size, lineHeight: 1.12, fontWeight: 700, color: theme.ink, margin: 0, letterSpacing: -0.5 };
}

export function bodyStyle(theme: DeckTheme, size: number, muted = false): CSSProperties {
  return { fontFamily: theme.bodyFont, fontSize: size, lineHeight: 1.35, color: muted ? theme.muted : theme.ink, margin: 0 };
}

/** The accent bar above a headline. */
export function Bar({ theme }: { theme: DeckTheme }) {
  return <div style={{ width: 56, height: 6, borderRadius: 3, background: theme.accent, marginBottom: 28 }} />;
}

export function Headline({ theme, size, children }: { theme: DeckTheme; size: number; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Bar theme={theme} />
      <h2 style={headingStyle(theme, size)}>{children}</h2>
    </div>
  );
}

/** A point list: each point with a small accent mark. */
export function Points({ theme, points, size = 28 }: { theme: DeckTheme; points: string[]; size?: number }) {
  if (!points.length) return null;
  return (
    <ul style={{ display: "flex", flexDirection: "column", gap: 18, listStyle: "none", padding: 0, margin: 0 }}>
      {points.map((p, i) => (
        <li key={i} style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 18 }}>
          <span style={{ flex: "none", width: 12, height: 12, borderRadius: 6, background: theme.accent, marginTop: size * 0.45 }} />
          <span style={bodyStyle(theme, size)}>{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** Where a number came from, with its date, or that it fills when the slide is saved. */
export function blockLabel(b: MetricBlock, now: Date): string {
  if (isPending(b)) return LABEL_WORDS.fillsOnSave;
  const label = labelWords(b, now);
  return b.source.saidInChat ? `${label}, ${LABEL_WORDS.saidInChat}` : label;
}

/**
 * A number shown large: its figure, its name and where it came from. "said in chat" is for the
 * studio: Present and the PDF show only the label ("Typed by you, 26 Nov").
 */
export function BigBlock({ theme, block, now, mode, size = 96 }: { theme: DeckTheme; block: MetricBlock; now: Date; mode: SlideMode; size?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <span style={{ ...headingStyle(theme, size), color: theme.accentText, lineHeight: 1 }}>{block.display || "…"}</span>
      <span style={bodyStyle(theme, 24)}>{block.periodWords ? `${block.name}, ${block.periodWords}` : block.name}</span>
      <span style={bodyStyle(theme, 18, true)}>{mode === "edit" ? blockLabel(block, now) : labelWords(block, now)}</span>
    </div>
  );
}

/** Initials for a person on the team slide: no photos. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts.slice(0, 1);
  return letters.map((p) => p[0]!.toUpperCase()).join("") || "?";
}

/** The body of a slide below its corner: fills the frame, laid out in a column. */
export function Body({ children, gap = 40, center = false }: { children: ReactNode; gap?: number; center?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap, justifyContent: center ? "center" : "flex-start", minHeight: 0 }}>{children}</div>
  );
}
