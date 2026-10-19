import type { ReactElement } from "react";
import { Brand, Headline, glow, headlineLength, headlineWords, isLandscape, rgba, sizeFor, withAlpha, full, type TemplateInput } from "./shared";
import { skinFor } from "./skins";

/**
 * The three formats (IMAGE_FORMATS_ENABLED). Each is a layout; the style it's made in lends the
 * skin (skins.ts). A painted scene comes in as `art` (never a person, never a logo): portrait
 * and partner cards always ask for one, a report cover in a painted style too. Without art,
 * each is drawn from type alone.
 */

function SceneImage({ art, x, y, w, h, radius }: { art: NonNullable<TemplateInput["art"]>; x: number; y: number; w: number; h: number; radius: number }) {
  return (
    <div style={{ position: "absolute", display: "flex", left: x, top: y, width: w, height: h, borderRadius: radius, overflow: "hidden" }}>
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
      <img src={art.src} width={w} height={h} style={{ objectFit: "cover" }} />
    </div>
  );
}

/** Portrait card: a person's words, with their name and role; the picture is a painted scene. */
export function portraitCard(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const skin = skinFor(i.skin, i.accent);
  const f = i.formatInputs ?? {};
  const quote = (f.quote || i.headline).replace(/^["“”']+|["“”']+$/g, "");
  const pad = unit * 6.5;
  const scene = land ? { x: pad, y: pad, w: W * 0.36, h: H - pad * 2 } : { x: pad, y: pad + unit * 7, w: W - pad * 2, h: H * 0.34 };
  const text = land ? { x: scene.x + scene.w + pad, y: pad, w: W - scene.w - pad * 3 } : { x: pad, y: scene.y + scene.h + unit * 4, w: W - pad * 2 };
  const size = sizeFor(quote.length, unit * (land ? 6.4 : 6.8), unit * 3.6);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: skin.ground, color: skin.ink, fontFamily: i.fonts.body, overflow: "hidden" }}>
      {i.art ? (
        <SceneImage art={i.art} {...scene} radius={unit * 2.4} />
      ) : (
        <div style={{ position: "absolute", display: "flex", left: scene.x, top: scene.y, width: scene.w, height: scene.h, borderRadius: unit * 2.4, background: withAlpha(skin.lit, 0.14), alignItems: "center", justifyContent: "center", fontFamily: i.fonts.heading, fontWeight: 800, fontSize: Math.min(scene.w, scene.h) * 0.7, color: skin.lit }}>
          “
        </div>
      )}
      {land ? null : (
        <div style={{ position: "absolute", display: "flex", left: pad, top: pad, width: W - pad * 2, justifyContent: "space-between", alignItems: "center" }}>
          {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color={skin.ink} font={i.fonts.heading} /> : <div style={{ display: "flex" }} />}
          <div style={{ display: "flex", fontSize: unit * 2.1, letterSpacing: "0.12em", textTransform: "uppercase", color: skin.muted }}>{i.eyebrow ?? ""}</div>
        </div>
      )}
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", left: text.x, top: text.y, width: text.w, ...(land ? { height: H - pad * 2 } : { bottom: pad }) }}>
        {land ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color={skin.ink} font={i.fonts.heading} /> : <div style={{ display: "flex" }} />}
            <div style={{ display: "flex", fontSize: unit * 2.1, letterSpacing: "0.12em", textTransform: "uppercase", color: skin.muted }}>{i.eyebrow ?? ""}</div>
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <Headline
            words={headlineWords(`“${quote}”`)}
            size={size}
            color={skin.ink}
            highlight={{ color: skin.lit }}
            style={{ fontFamily: i.fonts.heading, fontWeight: skin.weight, letterSpacing: "-0.015em", lineHeight: 1.18 }}
          />
        </div>
        {f.name ? (
          <div style={{ display: "flex", flexDirection: "column", marginTop: unit * 2 }}>
            <div style={{ display: "flex", fontSize: unit * 3, fontWeight: 700 }}>{f.name}</div>
            {f.role ? <div style={{ display: "flex", fontSize: unit * 2.4, color: skin.muted, marginTop: unit * 0.6 }}>{f.role}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Partner lockup: your logo × the partner's name in type (never their logo), over a painted scene. */
export function partnerLockup(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const unit = Math.min(W, H) / 100;
  const skin = skinFor(i.skin, i.accent);
  const f = i.formatInputs ?? {};
  const partner = (f.partner || "Partner").trim();
  const line = f.line || i.headline;
  const nameSize = Math.round(Math.min(unit * 9, (W * 0.36) / Math.max(4, partner.length * 0.56)));
  const lineSize = sizeFor(headlineLength(line), unit * 5.6, unit * 3.4);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: skin.ground, color: skin.ink, fontFamily: i.fonts.body, overflow: "hidden" }}>
      {i.art ? (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img src={i.art.src} width={W} height={H} style={{ position: "absolute", left: 0, top: 0, objectFit: "cover" }} />
      ) : (
        <div style={{ ...full(W, H), background: glow(rgba(i.accent, 0.28)) }} />
      )}
      {i.art ? <div style={{ ...full(W, H), background: withAlpha(skin.base, 0.76) }} /> : null}
      <div style={{ position: "absolute", display: "flex", left: unit * 6.5, top: unit * 6, fontSize: unit * 2.1, letterSpacing: "0.14em", textTransform: "uppercase", color: skin.muted }}>
        {i.eyebrow ?? "Partner"}
      </div>
      <div style={{ ...full(W, H), flexDirection: "column", alignItems: "center", justifyContent: "center", padding: `0 ${unit * 7}px` }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Brand logo={i.logo} brandName={i.brandName} height={nameSize * 1.6} color={skin.ink} font={i.fonts.heading} />
          <div style={{ display: "flex", margin: `0 ${unit * 3}px`, fontSize: nameSize * 0.9, fontWeight: 300, color: skin.muted }}>×</div>
          <div style={{ display: "flex", fontFamily: i.fonts.heading, fontWeight: 700, fontSize: nameSize, letterSpacing: "-0.02em" }}>{partner}</div>
        </div>
        <div style={{ display: "flex", marginTop: unit * 5, justifyContent: "center", textAlign: "center", maxWidth: W * 0.8 }}>
          <Headline words={headlineWords(line)} size={lineSize} color={skin.ink} highlight={{ color: skin.lit }} style={{ fontFamily: i.fonts.heading, fontWeight: skin.weight, justifyContent: "center" }} />
        </div>
      </div>
      {i.footer ? (
        <div style={{ position: "absolute", display: "flex", right: unit * 6.5, bottom: unit * 6, fontSize: unit * 2, color: skin.muted }}>{i.footer}</div>
      ) : null}
    </div>
  );
}

/** Report cover: the front of a study or yearly report (and an eBook's cover). */
export function reportCover(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const skin = skinFor(i.skin, i.accent);
  const f = i.formatInputs ?? {};
  const title = f.title || i.headline;
  const subtitle = f.subtitle || i.subline || "";
  const figure = f.figure ?? i.figure ?? null;
  const pad = unit * 7;
  const titleSize = sizeFor(headlineLength(title), unit * (land ? 9 : 10.5), unit * 5);
  const art = i.art ? (land ? { x: W * 0.56, y: pad, w: W * 0.44 - pad, h: H - pad * 2 } : { x: pad, y: H * 0.5, w: W - pad * 2, h: H * 0.26 }) : null;
  const textW = land && art ? W * 0.5 - pad : W - pad * 2;

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: skin.ground, color: skin.ink, fontFamily: i.fonts.body, overflow: "hidden" }}>
      {art && i.art ? <SceneImage art={i.art} {...art} radius={unit * 1.6} /> : null}
      <div style={{ position: "absolute", display: "flex", left: pad, top: pad, fontSize: unit * 2.1, letterSpacing: "0.14em", textTransform: "uppercase", color: skin.muted }}>
        {i.eyebrow ?? "Report"}
      </div>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", left: pad, top: pad + unit * 7, width: textW }}>
        <Headline words={headlineWords(title)} size={titleSize} color={skin.ink} highlight={{ color: skin.lit }} style={{ fontFamily: i.fonts.heading, fontWeight: skin.weight, letterSpacing: "-0.02em", lineHeight: 1.02 }} />
        {subtitle ? <div style={{ display: "flex", marginTop: unit * 3, fontSize: unit * 3, lineHeight: 1.35, color: skin.muted }}>{subtitle}</div> : null}
      </div>
      {figure ? (
        <div
          style={{
            position: "absolute",
            display: "flex",
            alignItems: "baseline",
            left: pad,
            // Without art a tall cover holds its number mid-page; with art, under the picture.
            ...(!art && !land ? { top: H * 0.56 } : { bottom: pad + unit * 7 }),
            color: skin.lit,
          }}
        >
          <div style={{ display: "flex", fontFamily: i.fonts.heading, fontWeight: 800, fontSize: unit * (land ? 13 : 15), letterSpacing: "-0.04em", lineHeight: 1 }}>{figure.value}</div>
          {figure.unit ? <div style={{ display: "flex", marginLeft: unit * 1.6, fontSize: unit * 3.4, fontWeight: 600 }}>{figure.unit}</div> : null}
        </div>
      ) : null}
      <div style={{ position: "absolute", display: "flex", left: pad, bottom: pad, width: (land && art ? W * 0.5 : W) - pad * 2, justifyContent: "space-between", alignItems: "center" }}>
        {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color={skin.ink} font={i.fonts.heading} /> : <div style={{ display: "flex" }} />}
        <div style={{ display: "flex", fontSize: unit * 2, color: skin.muted }}>{i.footer ?? ""}</div>
      </div>
    </div>
  );
}
