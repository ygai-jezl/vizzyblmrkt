import type { ReactElement } from "react";
import { Brand, Headline, headlineLength, headlineWords, isLandscape, mix, sizeFor, type TemplateInput } from "./shared";

/**
 * 12 Split card: a painted photo on one half (Natural photo, cropped to its half), beside a deep
 * panel of the brand accent with the headline (its phrase lit in a pale accent), a "Read more"
 * pill and a quiet line at the foot. Side by side when wide, photo over panel when square or
 * tall. Without art (painting failed), the panel fills the frame.
 */
export function splitCard(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const panel = mix(i.accent, "#0A0A0A", 0.78);
  const light = mix(i.accent, "#FFFFFF", 0.45);
  const muted = mix(i.accent, "#FFFFFF", 0.62);
  const art = i.art ?? null;
  const photo = art ? (land ? { x: 0, y: 0, w: W * 0.52, h: H } : { x: 0, y: 0, w: W, h: H * 0.5 }) : null;
  const box = photo ? (land ? { x: photo.w, y: 0, w: W - photo.w, h: H } : { x: 0, y: photo.h, w: W, h: H - photo.h }) : { x: 0, y: 0, w: W, h: H };
  const pad = unit * (land ? 7 : 7.4);
  const size = sizeFor(headlineLength(i.headline), unit * (photo ? (land ? 7 : 7.4) : 10), unit * 4.4);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: panel, color: "#FFFFFF", fontFamily: i.fonts.body, overflow: "hidden" }}>
      {photo && art ? (
        <div style={{ position: "absolute", display: "flex", left: photo.x, top: photo.y, width: photo.w, height: photo.h, overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={art.src} width={photo.w} height={photo.h} style={{ objectFit: "cover" }} />
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          display: "flex",
          flexDirection: "column",
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          padding: `${pad * 0.8}px ${pad}px ${pad * 0.7}px`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color="#FFFFFF" font={i.fonts.heading} /> : <div style={{ display: "flex" }} />}
          <div style={{ display: "flex", fontSize: unit * 2.2, color: muted }}>{i.eyebrow ?? ""}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <Headline
            words={headlineWords(i.headline)}
            size={size}
            color="#FFFFFF"
            highlight={{ color: light }}
            style={{ fontFamily: i.fonts.heading, fontWeight: 600, letterSpacing: "-0.015em" }}
          />
          <div style={{ display: "flex", marginTop: unit * 3.4 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "#FFFFFF",
                color: mix(i.accent, "#000000", 0.75),
                fontSize: unit * 2.6,
                fontWeight: 600,
                borderRadius: 999,
                padding: `${unit * 1.5}px ${unit * 2.6}px`,
              }}
            >
              Read more →
            </div>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: unit * 2.2, color: muted }}>{i.subline ?? i.footer ?? ""}</div>
      </div>
    </div>
  );
}
