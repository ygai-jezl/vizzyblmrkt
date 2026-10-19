import type { ReactElement } from "react";
import { Brand, headlineLength, highlightedText, inkOn, isLandscape, rgba, type TemplateInput } from "./shared";

/** The big words when there's no number: the highlighted phrase, else the first word. */
function fallbackFigure(headline: string): { value: string; unit: string } {
  const hi = highlightedText(headline);
  const first = headline.replace(/\*/g, "").trim().split(/\s+/)[0] ?? "";
  return { value: (hi ?? first).slice(0, 14), unit: "" };
}

/**
 * 04 Type poster: one block of the brand accent and giant type. The big number sits bottom left
 * (its unit under it, in capitals), the sentence it comes from beside it, a ruled label row on
 * top and the brand at the foot.
 */
export function typePoster(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const ink = inkOn(i.accent) === "#FFFFFF" ? "#F6F3EC" : "#111111";
  const rule = rgba(ink, 0.45);
  const fig = i.figure ?? fallbackFigure(i.headline);
  const unitLine = fig.unit ? `${fig.unit.toUpperCase()}.` : "";
  const chars = Math.max(fig.value.length, unitLine.length, 2);
  const roomW = land ? W * 0.54 : W * 0.86;
  const lines = unitLine ? 2 : 1;
  const roomH = land ? H * 0.68 : H * 0.42;
  const size = Math.round(Math.min(roomW / (chars * 0.62), roomH / (lines * 0.98)));
  const caption = i.headline.replace(/\*/g, "");
  const captionSize = Math.round(unit * (headlineLength(caption) > 90 ? 3.2 : 3.9));
  const pad = unit * 6;

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: i.accent, color: ink, fontFamily: i.fonts.body, overflow: "hidden" }}>
      <div style={{ position: "absolute", display: "flex", left: pad, top: pad * 0.8, width: W - pad * 2, justifyContent: "space-between", fontSize: unit * 2, letterSpacing: "0.14em", textTransform: "uppercase" }}>
        <div style={{ display: "flex" }}>{i.eyebrow ? `• ${i.eyebrow}` : ""}</div>
        <div style={{ display: "flex" }}>{i.footer ?? ""}</div>
      </div>
      <div style={{ position: "absolute", display: "flex", left: pad, top: pad * 0.8 + unit * 5, width: W - pad * 2, height: Math.max(2, Math.round(unit * 0.2)), background: rule }} />

      <div style={{ position: "absolute", display: "flex", flexDirection: "column", left: pad * 0.8, bottom: pad * 0.7, fontFamily: i.fonts.heading, fontWeight: 700, fontSize: size, lineHeight: 0.9, letterSpacing: "-0.045em" }}>
        <div style={{ display: "flex" }}>{fig.value}</div>
        {unitLine ? <div style={{ display: "flex", marginTop: size * 0.14 }}>{unitLine}</div> : null}
      </div>

      <div
        style={{
          position: "absolute",
          display: "flex",
          flexDirection: "column",
          ...(land ? { left: W * 0.6, top: H * 0.22, width: W * 0.34 } : { left: pad, top: pad * 0.8 + unit * 9, width: W - pad * 2 }),
        }}
      >
        <div style={{ display: "flex", fontSize: captionSize, lineHeight: 1.3, fontWeight: 500, letterSpacing: "-0.01em" }}>{caption}</div>
        {i.subline ? (
          <div style={{ display: "flex", marginTop: unit * 2, fontSize: unit * 2, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.85 }}>{i.subline}</div>
        ) : null}
      </div>

      {i.showLogo !== false ? (
        <div style={{ position: "absolute", display: "flex", right: pad, bottom: pad * 0.8 }}>
          <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color={ink} font={i.fonts.heading} />
        </div>
      ) : null}
    </div>
  );
}
