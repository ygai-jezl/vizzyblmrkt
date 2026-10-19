import type { ReactElement } from "react";
import { Brand, Headline, headlineLength, headlineWords, highlightedText, isLandscape, mix, rgba, sizeFor, type TemplateInput } from "./shared";

const PAPER = "#FBF8F3";
const INK = "#1F1D1A";
const MUTED = "#8A847B";

/** A small seeded random number generator (mulberry32): the same seed, the same drawing. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from text (FNV-1a), plus the attempt so Make again draws anew. */
export function seedFor(text: string, attempt = 0): number {
  let h = 0x811c9dc5;
  for (const ch of `${text}#${attempt}`) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/**
 * 13 Line art: fine lines in the accent on dotted paper. A family of waves, contour rings round
 * a point and a measured bracket, all placed by a seeded random so each title gets its own
 * drawing (and Make again a new one); the headline, a label row and the brand in type. No
 * image model.
 */
export function lineArt(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const rnd = seeded(i.seed ?? seedFor(i.headline));
  const stroke = Math.max(1, unit * 0.16);
  const pad = unit * 6;

  // The drawing's area: the right of a wide frame, the lower part of a square or tall one.
  const area = land ? { x: W * 0.46, y: H * 0.12, w: W * 0.54, h: H * 0.88 } : { x: 0, y: H * 0.42, w: W, h: H * 0.58 };
  const cx = area.x + area.w * (0.45 + rnd() * 0.2);
  const cy = area.y + area.h * (0.38 + rnd() * 0.2);
  const r0 = Math.min(area.w, area.h) * (0.16 + rnd() * 0.06);

  // Waves: ten bezier lines, each a little lower, sweeping through the drawing's lower half.
  const amp = area.h * (0.1 + rnd() * 0.12);
  const phase = rnd();
  const gap = area.h * (0.035 + rnd() * 0.015);
  const waveY = area.y + area.h * (0.52 + rnd() * 0.12);
  const waves = Array.from({ length: 10 }, (_, k) => {
    const y = waveY + k * gap;
    const x0 = area.x - unit * 4;
    const x1 = area.x + area.w + unit * 4;
    const span = x1 - x0;
    const c1y = y - amp * (0.6 + phase) + k * gap * 0.2;
    const c2y = y + amp * (1.4 - phase) - k * gap * 0.1;
    return `M${x0.toFixed(1)} ${y.toFixed(1)} C ${(x0 + span * 0.3).toFixed(1)} ${c1y.toFixed(1)}, ${(x0 + span * 0.62).toFixed(1)} ${c2y.toFixed(1)}, ${x1.toFixed(1)} ${(y - amp * 0.3).toFixed(1)}`;
  });

  // A measured bracket above the rings.
  const bw = r0 * (1.4 + rnd() * 0.6);
  const by = cy - r0 * 1.55;
  const bracket = `M${(cx - bw / 2).toFixed(1)} ${by.toFixed(1)} H${(cx + bw / 2).toFixed(1)} M${(cx - bw / 2).toFixed(1)} ${(by - unit).toFixed(1)} V${(by + unit).toFixed(1)} M${(cx + bw / 2).toFixed(1)} ${(by - unit).toFixed(1)} V${(by + unit).toFixed(1)}`;
  const mark = ((i.figure ? `${i.figure.value} ${i.figure.unit}`.trim() : highlightedText(i.headline)) ?? "").replace(/[.,;:!?]+$/, "");

  // The dot grid, as one pattern.
  const dot = unit * 2.4;
  const size = sizeFor(headlineLength(i.headline), unit * (land ? 7 : 8), unit * 4.4);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: PAPER, color: INK, fontFamily: i.fonts.body, overflow: "hidden" }}>
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <pattern id="dots" width={dot} height={dot} patternUnits="userSpaceOnUse">
            <circle cx={dot / 2} cy={dot / 2} r={Math.max(0.8, unit * 0.12)} fill="rgba(20,20,20,0.10)" />
          </pattern>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill="url(#dots)" />
        {waves.map((d, k) => (
          <path key={k} d={d} stroke={i.accent} strokeWidth={stroke} fill="none" opacity={0.26} />
        ))}
        {[1, 1.4, 1.85].map((m, k) => (
          <circle key={k} cx={cx} cy={cy} r={r0 * m} stroke={i.accent} strokeWidth={stroke} fill="none" opacity={[0.3, 0.17, 0.09][k]} />
        ))}
        <circle cx={cx} cy={cy} r={r0 * 0.7} stroke={i.accent} strokeWidth={stroke * 2.2} fill="none" />
        <circle cx={cx} cy={cy} r={unit * 0.9} fill={i.accent} />
        <path d={`M${cx} ${cy} L${(cx + r0 * 0.5).toFixed(1)} ${(cy + r0 * 0.5).toFixed(1)}`} stroke={i.accent} strokeWidth={stroke * 1.4} strokeLinecap="round" />
        {mark ? <path d={bracket} stroke={i.accent} strokeWidth={stroke * 1.3} fill="none" /> : null}
      </svg>
      {mark ? (
        <div
          style={{
            position: "absolute",
            display: "flex",
            justifyContent: "center",
            left: cx - unit * 25,
            width: unit * 50,
            top: by - unit * 5.2,
            fontSize: unit * 2.2,
            fontWeight: 500,
            color: i.accent,
          }}
        >
          <span style={{ background: PAPER, padding: `0 ${unit}px` }}>{mark}</span>
        </div>
      ) : null}

      <div style={{ position: "absolute", display: "flex", left: pad, top: pad * 0.8, fontSize: unit * 2, letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED }}>
        {i.eyebrow ?? ""}
      </div>
      <div style={{ position: "absolute", display: "flex", left: pad, top: pad * 0.8 + unit * 6, width: land ? W * 0.42 : W - pad * 2 }}>
        <Headline
          words={headlineWords(i.headline)}
          size={size}
          color={INK}
          highlight={{ color: i.accent, background: rgba(i.accent, 0.1), borderRadius: size * 0.15, padding: `0 ${size * 0.15}px` }}
          style={{ fontFamily: i.fonts.heading, fontWeight: 600, letterSpacing: "-0.02em" }}
        />
      </div>
      <div style={{ position: "absolute", display: "flex", left: pad, bottom: pad * 0.8, alignItems: "center" }}>
        {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.4} color={INK} font={i.fonts.heading} /> : null}
      </div>
      <div style={{ position: "absolute", display: "flex", right: pad, bottom: pad * 0.9, fontSize: unit * 2, color: mix(MUTED, INK, 0.2) }}>{i.footer ?? ""}</div>
    </div>
  );
}
