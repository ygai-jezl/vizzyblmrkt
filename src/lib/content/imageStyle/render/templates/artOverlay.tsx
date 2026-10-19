import type { ReactElement } from "react";
import { Brand, full, Headline, headlineLength, headlineWords, sizeFor, type TemplateInput } from "./shared";

/**
 * Type over image-model art: the art fills the frame (cropped to it), a soft dark scrim at the
 * foot carries the headline, and the logo sits in a corner. Used for share cards made from a
 * painted hero, and for social images when the brand puts its headline or logo on them.
 */
export function artOverlay(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const unit = Math.min(W, H) / 100;
  const withHeadline = i.showHeadline !== false && headlineLength(i.headline) > 0;
  const size = sizeFor(headlineLength(i.headline), unit * 8.5, unit * 4.6);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: "#0B0B10", fontFamily: i.fonts.body, overflow: "hidden" }}>
      {i.art ? (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img src={i.art.src} width={W} height={H} style={{ position: "absolute", left: 0, top: 0, objectFit: "cover" }} />
      ) : null}
      {withHeadline ? (
        <div
          style={{ ...full(W, H), background: "linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.35) 62%, rgba(0,0,0,0.8) 100%)" }}
        />
      ) : null}
      {withHeadline ? (
        <div style={{ position: "absolute", display: "flex", left: W * 0.06, right: W * 0.06, bottom: H * 0.07 }}>
          <Headline
            words={headlineWords(i.headline)}
            size={size}
            color="#FFFFFF"
            highlight={{ color: "#FFFFFF", borderBottom: `${Math.max(3, size * 0.08)}px solid ${i.accent}` }}
            style={{ fontFamily: i.fonts.heading, fontWeight: 700, letterSpacing: "-0.015em" }}
          />
        </div>
      ) : null}
      {i.showLogo !== false ? (
        <div style={{ position: "absolute", display: "flex", left: W * 0.05, top: H * 0.05 }}>
          <Brand logo={i.logo} brandName={i.brandName} height={unit * 5} color="#FFFFFF" font={i.fonts.heading} />
        </div>
      ) : null}
    </div>
  );
}
