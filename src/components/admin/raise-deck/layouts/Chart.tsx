import { DeckChart } from "../DeckChart";
import { BigBlock, bodyStyle, Body, Headline, isSeriesBlock, said, shownBlocks, type LayoutProps } from "./parts";

/** A headline, one series drawn as a line chart with its source line, and up to one big number. */
export function Chart({ slide, theme, mode, now }: LayoutProps) {
  const blocks = shownBlocks(slide, mode);
  const series = blocks.find(isSeriesBlock) ?? null;
  const big = blocks.find((b) => b !== series && !isSeriesBlock(b)) ?? null;
  const point = slide.points.map((p) => said(slide, p)).find(Boolean);
  return (
    <Body gap={36}>
      <Headline theme={theme} size={46}>
        {said(slide, slide.headline)}
      </Headline>
      <div style={{ display: "flex", flexDirection: "row", gap: 48, alignItems: "flex-end", flex: 1, minHeight: 0 }}>
        {series ? (
          <DeckChart block={series} theme={theme} width={big ? 760 : 1100} height={360} />
        ) : mode === "edit" ? (
          <div style={{ display: "flex", width: big ? 760 : 1100, height: 360, border: `2px dashed ${theme.muted}`, borderRadius: 12 }} />
        ) : null}
        {big ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingBottom: 40 }}>
            <BigBlock theme={theme} block={big} now={now} size={80} />
          </div>
        ) : null}
      </div>
      {point ? <p style={{ ...bodyStyle(theme, 24, true), maxWidth: 1000 }}>{point}</p> : null}
    </Body>
  );
}
