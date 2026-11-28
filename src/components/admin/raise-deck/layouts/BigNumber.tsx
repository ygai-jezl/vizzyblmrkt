import { BigBlock, bodyStyle, Body, Headline, said, shownBlocks, type LayoutProps } from "./parts";

/** A headline and one to three numbers shown large, each with its name and where it came from. */
export function BigNumber({ slide, theme, mode, now }: LayoutProps) {
  const blocks = shownBlocks(slide, mode).slice(0, 3);
  const point = slide.points.map((p) => said(slide, p)).find(Boolean);
  return (
    <Body gap={52}>
      <Headline theme={theme} size={48}>
        {said(slide, slide.headline)}
      </Headline>
      {blocks.length ? (
        <div style={{ display: "flex", flexDirection: "row", gap: 56 }}>
          {blocks.map((b) => (
            <div key={b.id} style={{ display: "flex", flex: 1, minWidth: 0 }}>
              <BigBlock theme={theme} block={b} now={now} mode={mode} size={blocks.length > 2 ? 76 : 96} />
            </div>
          ))}
        </div>
      ) : null}
      {point ? <p style={{ ...bodyStyle(theme, 26, true), maxWidth: 980 }}>{point}</p> : null}
    </Body>
  );
}
