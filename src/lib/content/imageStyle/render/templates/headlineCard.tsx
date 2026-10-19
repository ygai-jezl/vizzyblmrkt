import type { ReactElement } from "react";
import { Brand, full, glow, Headline, headlineLength, headlineWords, isLandscape, mix, rgba, tint, sizeFor, inkOn, type TemplateInput } from "./shared";

/** A faint constellation of lines, as in the canvas mockup (drawn in a 960×540 box, scaled). */
const LINES = [
  "M40 60 L180 30 L320 110 L90 200 Z", "M180 30 L420 40 L320 110", "M420 40 L600 90 L480 200 L320 110",
  "M600 90 L760 30 L900 120 L700 200 Z", "M700 200 L860 260 L900 120", "M480 200 L540 300 L700 200",
  "M90 200 L260 250 L320 110", "M260 250 L380 380 L540 300 L480 200 Z", "M380 380 L150 420 L260 250",
  "M150 420 L60 520 L300 500 Z", "M300 500 L380 380 L620 470 Z", "M620 470 L800 430 L860 260 L540 300",
  "M800 430 L930 500 L860 260",
];

/**
 * 02 Headline card: deep navy ground leaning to the brand accent, a two-tone headline with the
 * key phrase on an accent block, the logo top left and a small label top right.
 */
export function headlineCard(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const pad = land ? { x: W * 0.058, y: H * 0.078 } : { x: W * 0.074, y: W * 0.074 };
  const size = sizeFor(headlineLength(i.headline), unit * 12.5, unit * 5.6);
  const g1 = mix("#0B1130", i.accent, 0.08);
  const g2 = mix("#10183D", i.accent, 0.12);
  const g3 = mix("#1A1452", i.accent, 0.18);

  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: W,
        height: H,
        background: `linear-gradient(155deg, ${g1} 0%, ${g2} 52%, ${g3} 100%)`,
        color: "#FFFFFF",
        fontFamily: i.fonts.body,
        overflow: "hidden",
      }}
    >
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={W} height={H} viewBox="0 0 960 540" preserveAspectRatio="xMidYMid slice">
        {LINES.map((d) => (
          <path key={d} d={d} stroke="rgba(150,160,255,0.11)" strokeWidth={1} fill="none" />
        ))}
      </svg>
      <div
        style={{
          position: "absolute",
          display: "flex",
          left: W * 0.4,
          top: H * 0.5,
          width: W * 0.75,
          height: H * 0.8,
          background: glow(rgba(i.accent, 0.24)),
        }}
      />

      <div style={{ ...full(W, H), flexDirection: "column", padding: `${pad.y}px ${pad.x}px` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {i.showLogo !== false ? (
            <Brand logo={i.logo} brandName={i.brandName} height={unit * 5.6} color="#FFFFFF" font={i.fonts.heading} />
          ) : (
            <div style={{ display: "flex" }} />
          )}
          {i.eyebrow ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                fontSize: unit * 2,
                fontWeight: 700,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "#C9CCF5",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 999,
                padding: `${unit * 1.1}px ${unit * 2.2}px`,
              }}
            >
              <div style={{ display: "flex", width: unit * 1.1, height: unit * 1.1, borderRadius: 999, background: tint(i.accent, 0.4), marginRight: unit * 1.4 }} />
              {i.eyebrow}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", ...(land ? { maxWidth: W * 0.78 } : {}) }}>
          <Headline
            words={headlineWords(i.headline)}
            size={size}
            color="#FFFFFF"
            mutedBefore="#B7BCE6"
            highlight={{ background: i.accent, color: inkOn(i.accent), borderRadius: size * 0.2, padding: `0 ${size * 0.26}px` }}
            style={{ fontFamily: i.fonts.heading, fontWeight: 800, letterSpacing: "-0.02em" }}
          />
          {i.subline ? (
            <div style={{ display: "flex", marginTop: unit * 3, fontSize: unit * 3, lineHeight: 1.4, color: "#B7BCE6", ...(land ? { maxWidth: W * 0.62 } : {}) }}>
              {i.subline}
            </div>
          ) : null}
        </div>

        {i.footer ? (
          <div style={{ display: "flex", fontSize: unit * 2, letterSpacing: "0.06em", color: "#8188BC" }}>{i.footer}</div>
        ) : null}
      </div>
    </div>
  );
}
