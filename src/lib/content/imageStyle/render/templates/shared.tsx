import type { CSSProperties, ReactElement } from "react";
import type { Chart, ChartPoint, Figure, FormatInputs } from "@/lib/types/imageStyle";

/**
 * Pieces every template shares: colour maths, the headline laid out word by word (Satori has no
 * inline highlight, so a highlighted phrase is its own box), size by length, and the logo chip.
 * Templates are plain elements for next/og: flexbox only, every box with several children is
 * `display: flex`, images are data URIs.
 */

export interface TemplateImage {
  /** data: URI (PNG, JPEG or SVG). */
  src: string;
  width: number;
  height: number;
}

export interface TemplateInput {
  width: number;
  height: number;
  /** The words on the image. `*stars*` mark the phrase to highlight. */
  headline: string;
  /** Small line above the headline (a category, "Original research"). */
  eyebrow?: string | null;
  /** A supporting line under the headline. */
  subline?: string | null;
  /** A quiet line at the foot (the brand's site). */
  footer?: string | null;
  accent: string;
  brandName: string;
  logo?: TemplateImage | null;
  /** Product noir: one screen of the product. */
  screenshot?: TemplateImage | null;
  /** Type laid over image-model art. */
  art?: TemplateImage | null;
  showHeadline?: boolean;
  showLogo?: boolean;
  fonts: { heading: string; body: string };
  /** Data story: the numbers to chart (checked against the copy, or typed by a person). */
  chart?: Chart | null;
  /** Type poster: the one big number. */
  figure?: Figure | null;
  /** Line art: picks the pattern (the title, plus the attempt for Make again). */
  seed?: number;
  /** Formats: what they draw, and the style that skins them. */
  formatInputs?: FormatInputs | null;
  skin?: string | null;
}

/** A point's number as drawn: the copy's own writing, else the value with its unit. */
export function pointText(p: ChartPoint, unit: string): string {
  if (p.display) return p.display;
  const n = Number.isInteger(p.value) ? p.value.toLocaleString("en-US") : String(p.value);
  if (!unit) return n;
  return /^[%x×]$/.test(unit) ? `${n}${unit}` : `${n} ${unit}`;
}

/** The words a headline highlights (its *stars*), or null. */
export function highlightedText(raw: string): string | null {
  const words = headlineWords(raw).filter((w) => w.highlight).map((w) => w.text);
  return words.length ? words.join(" ") : null;
}

// ── colour ─────────────────────────────────────────────────────────────────────────────────────

export function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? [91, 79, 230] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** Any colour this file makes (#hex or rgb()) at an alpha. */
export function withAlpha(color: string, a: number): string {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color.trim());
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : rgba(color, a);
}

/** Towards white by t (0 to 1). */
export function tint(hex: string, t: number): string {
  const [r, g, b] = rgb(hex);
  return `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`;
}
/** Mix two hex colours, t of the second. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** White or near-black, whichever reads on the colour. */
export function inkOn(hex: string): string {
  return luminance(hex) > 0.42 ? "#111114" : "#FFFFFF";
}

// ── text ───────────────────────────────────────────────────────────────────────────────────────

const MAX_HEADLINE = 140;

export interface Word {
  text: string;
  highlight: boolean;
}

/**
 * Split the headline into words, marking the highlighted phrase: the `*starred*` words, else a
 * number and the word after it (stats carry the point), else nothing.
 */
export function headlineWords(raw: string): Word[] {
  let text = raw.replace(/\s+/g, " ").trim();
  if (text.replace(/\*/g, "").length > MAX_HEADLINE) {
    text = `${text.replace(/\*/g, "").slice(0, MAX_HEADLINE - 1).replace(/\s+\S*$/, "")}…`;
  }
  const words: Word[] = [];
  let inside = false;
  for (const token of text.split(" ")) {
    if (!token) continue;
    const opens = token.startsWith("*");
    const closes = token.endsWith("*") && (token.length > 1 || !opens);
    const bare = token.replace(/\*/g, "");
    if (!bare) {
      inside = !inside;
      continue;
    }
    if (opens) inside = true;
    words.push({ text: bare, highlight: inside });
    if (closes) inside = false;
  }
  if (!words.some((w) => w.highlight)) {
    const i = words.findIndex((w) => /\d/.test(w.text));
    if (i >= 0 && words.length > 2) {
      words[i]!.highlight = true;
      if (words[i + 1] && words[i + 1]!.text.length <= 12) words[i + 1]!.highlight = true;
    }
  }
  return words;
}

/** The headline's length without the stars, for sizing. */
export function headlineLength(raw: string): number {
  return raw.replace(/\*/g, "").replace(/\s+/g, " ").trim().length;
}

/** Font size by length: `base` for a short line, shrinking with the square root, never below `min`. */
export function sizeFor(length: number, base: number, min: number): number {
  return Math.round(Math.max(min, Math.min(base, base * Math.sqrt(24 / Math.max(length, 1)))));
}

/**
 * The headline as word boxes. Runs of highlighted words share one box, so the highlight reads
 * as a single phrase.
 */
export function Headline({
  words,
  size,
  color,
  mutedBefore,
  highlight,
  style,
}: {
  words: Word[];
  size: number;
  color: string;
  /** Words before the highlight in this colour (Headline card's two-tone line). */
  mutedBefore?: string;
  highlight: CSSProperties;
  style?: CSSProperties;
}): ReactElement {
  const groups: { text: string; highlight: boolean }[] = [];
  for (const w of words) {
    const last = groups[groups.length - 1];
    if (last && last.highlight && w.highlight) last.text += ` ${w.text}`;
    else groups.push({ text: w.text, highlight: w.highlight });
  }
  const firstHighlight = groups.findIndex((g) => g.highlight);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", fontSize: size, lineHeight: 1.12, ...style }}>
      {groups.map((g, i) => (
        <span
          key={i}
          style={{
            marginRight: size * 0.26,
            marginBottom: size * 0.06,
            color: mutedBefore && firstHighlight > 0 && i < firstHighlight ? mutedBefore : color,
            ...(g.highlight ? highlight : {}),
          }}
        >
          {g.text}
        </span>
      ))}
    </div>
  );
}

/** The logo on a light chip (it reads on any ground), or the brand name in type. */
export function Brand({
  logo,
  brandName,
  height,
  color,
  font,
}: {
  logo?: TemplateImage | null;
  brandName: string;
  height: number;
  color: string;
  font: string;
}): ReactElement {
  if (logo) {
    const h = Math.round(height * 0.62);
    const w = Math.min(Math.round((logo.width / Math.max(logo.height, 1)) * h), height * 5);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height,
          padding: `0 ${Math.round(height * 0.32)}px`,
          borderRadius: Math.round(height * 0.24),
          background: "rgba(255,255,255,0.94)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={logo.src} width={w} height={h} style={{ objectFit: "contain" }} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", fontFamily: font, fontWeight: 700, fontSize: Math.round(height * 0.62), color, letterSpacing: "-0.01em" }}>
      {brandName}
    </div>
  );
}

/**
 * A box covering the whole frame. Satori ignores `inset`, so a layer needs its size spelled out.
 */
export function full(W: number, H: number): CSSProperties {
  return { position: "absolute", left: 0, top: 0, width: W, height: H, display: "flex" };
}

/**
 * A soft glow that fades to nothing inside its box. (Satori draws `closest-side` inverted; with
 * the default farthest-corner ellipse, 70% lands on the box's edges.)
 */
export function glow(color: string): string {
  return `radial-gradient(${color} 0%, rgba(0,0,0,0) 70%)`;
}

/** Landscape (wider than 3:2) or not. */
export function isLandscape(i: { width: number; height: number }): boolean {
  return i.width / i.height >= 1.5;
}
