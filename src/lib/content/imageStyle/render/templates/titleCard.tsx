import type { ReactElement } from "react";
import { Brand, Headline, headlineLength, headlineWords, isLandscape, luminance, mix, sizeFor, type TemplateInput } from "./shared";

/**
 * The title card: the fallback that can't fail. A dark ground from the brand accent, an accent
 * rule, the title and the brand. Rendered with the bundled fonts, so it needs nothing fetched.
 */
export function titleCard(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const unit = Math.min(W, H) / 100;
  const land = isLandscape(i);
  const ground = luminance(i.accent) > 0.5 ? "#111827" : mix(i.accent, "#05060D", 0.78);
  const size = sizeFor(headlineLength(i.headline), unit * (land ? 14 : 15), unit * 6);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: W,
        height: H,
        padding: `${H * 0.11}px ${W * 0.07}px`,
        background: `linear-gradient(160deg, ${ground} 0%, ${mix(i.accent, "#05060D", 0.88)} 100%)`,
        color: "#FFFFFF",
        fontFamily: i.fonts.body,
      }}
    >
      <div style={{ display: "flex", width: unit * 9, height: unit * 1, borderRadius: 999, background: i.accent }} />
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingBottom: unit * 2 }}>
        <Headline
          words={headlineWords(i.headline).map((w) => ({ ...w, highlight: false }))}
          size={size}
          color="#FFFFFF"
          highlight={{}}
          style={{ fontFamily: i.fonts.heading, fontWeight: 700, letterSpacing: "-0.02em", ...(land ? { maxWidth: W * 0.8 } : {}) }}
        />
      </div>
      {i.showLogo !== false ? (
        <div style={{ display: "flex" }}>
          <Brand logo={i.logo} brandName={i.brandName} height={unit * 5.4} color="#FFFFFF" font={i.fonts.heading} />
        </div>
      ) : (
        <div style={{ display: "flex" }} />
      )}
    </div>
  );
}
