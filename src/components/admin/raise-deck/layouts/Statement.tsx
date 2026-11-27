import { bodyStyle, Body, Headline, said, type LayoutProps } from "./parts";

/** One large statement and up to one supporting point. */
export function Statement({ slide, theme }: LayoutProps) {
  const point = slide.points.map((p) => said(slide, p)).find(Boolean);
  return (
    <Body center gap={36}>
      <div style={{ maxWidth: 1040 }}>
        <Headline theme={theme} size={62}>
          {said(slide, slide.headline)}
        </Headline>
      </div>
      {point ? <p style={{ ...bodyStyle(theme, 30, true), maxWidth: 960 }}>{point}</p> : null}
    </Body>
  );
}
