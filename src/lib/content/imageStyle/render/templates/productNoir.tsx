import type { ReactElement } from "react";
import { Brand, glow, Headline, headlineLength, headlineWords, isLandscape, rgba, tint, sizeFor, type TemplateInput } from "./shared";

/**
 * 01 Product noir: near-black ground, the headline in a silver gradient, one real screen of the
 * product in a dark frame that fades into the ground. Without a screenshot the headline takes
 * the whole width. Landscape puts the screen on the right; square and portrait below.
 */
export function productNoir(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const shot = i.screenshot ?? null;
  const len = headlineLength(i.headline);
  const textWidth = shot ? (land ? W * 0.4 : W * 0.84) : W * 0.8;
  const size = sizeFor(len, shot ? unit * (land ? 12 : 10) : unit * 14, unit * 5.2);
  const accentText = tint(i.accent, 0.35);

  // Where the screen sits: right half bleeding off the foot, or the lower half.
  const frame = land
    ? { left: W * 0.47, top: H * 0.12, width: W * 0.5, height: H * 0.98 }
    : { left: W * 0.08, top: H * 0.5, width: W * 0.84, height: H * 0.62 };
  const shotHeight = shot ? Math.round((frame.width * shot.height) / Math.max(shot.width, 1)) : 0;

  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: W,
        height: H,
        background: "#09090B",
        color: "#EDEDEF",
        fontFamily: i.fonts.body,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", display: "flex", left: -W * 0.15, top: -H * 0.6, width: W * 0.85, height: H * 1.2, background: glow("rgba(255,255,255,0.09)") }} />
      {[0.25, 0.5, 0.75].map((x) => (
        <div key={x} style={{ position: "absolute", top: 0, bottom: 0, left: W * x, width: 1, display: "flex", background: "rgba(255,255,255,0.05)" }} />
      ))}
      <div
        style={{
          position: "absolute",
          display: "flex",
          left: shot ? frame.left - W * 0.04 : W * 0.45,
          top: shot ? frame.top - H * 0.08 : H * 0.1,
          width: shot ? frame.width * 1.1 : W * 0.6,
          height: H * 0.85,
          background: glow(rgba(i.accent, 0.26)),
        }}
      />

      {shot ? (
        <div
          style={{
            position: "absolute",
            display: "flex",
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: Math.min(frame.height, shotHeight + 2),
            borderRadius: unit * 1.6,
            border: "1px solid #25252A",
            background: "#111114",
            boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            overflow: "hidden",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={shot.src} width={frame.width} height={shotHeight} style={{ objectFit: "cover", objectPosition: "top" }} />
        </div>
      ) : null}
      {shot ? (
        <div
          style={{
            position: "absolute",
            display: "flex",
            left: frame.left - 2,
            top: frame.top,
            width: frame.width + 4,
            height: H - frame.top,
            background: "linear-gradient(180deg, rgba(9,9,11,0) 0%, rgba(9,9,11,0) 48%, rgba(9,9,11,0.94) 90%, #09090B 100%)",
          }}
        />
      ) : null}

      <div
        style={{
          position: "absolute",
          display: "flex",
          flexDirection: "column",
          left: land || !shot ? W * 0.065 : W * 0.08,
          top: land || !shot ? 0 : H * 0.08,
          ...(land || !shot ? { height: H, justifyContent: "center" } : { justifyContent: "flex-start" }),
          width: textWidth,
        }}
      >
        {i.eyebrow ? (
          <div style={{ display: "flex", fontSize: unit * 1.9, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6E6E76", marginBottom: unit * 2 }}>
            {i.eyebrow}
          </div>
        ) : null}
        <Headline
          words={headlineWords(i.headline)}
          size={size}
          color="#F4F4F5"
          highlight={{ color: accentText }}
          style={{
            fontFamily: i.fonts.heading,
            fontWeight: 600,
            letterSpacing: "-0.035em",
            lineHeight: 1.02,
            backgroundImage: "linear-gradient(180deg, #FAFAFA 0%, #C4C4CB 60%, #7E7E86 100%)",
            backgroundClip: "text",
          }}
        />
        {i.subline ? (
          <div style={{ display: "flex", marginTop: unit * 2.4, fontSize: unit * 2.7, lineHeight: 1.45, color: "#8E8E96" }}>{i.subline}</div>
        ) : null}
      </div>

      {i.showLogo !== false ? (
        <div
          style={{
            position: "absolute",
            display: "flex",
            // Below the text in landscape; top right when the screen fills the lower half.
            ...(land || !shot ? { left: W * 0.065, bottom: H * 0.07 } : { right: W * 0.08, top: H * 0.07 }),
          }}
        >
          <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.8} color="#EDEDEF" font={i.fonts.heading} />
        </div>
      ) : null}
    </div>
  );
}
