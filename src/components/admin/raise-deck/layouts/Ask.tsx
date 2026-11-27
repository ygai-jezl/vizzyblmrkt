import { SECTION_LABEL } from "@/lib/raise/docs/words";
import { BigBlock, bodyStyle, Body, Headline, Points, said, shownBlocks, type LayoutProps } from "./parts";

/**
 * The ask: a headline, the amount, up to 3 points on what it buys and one line on where it gets you.
 * A lender pack heads them What the money is for and How it repays, with no equity words.
 */
export function Ask({ slide, theme, audience, mode, now }: LayoutProps) {
  const amount = shownBlocks(slide, mode)[0] ?? null;
  const points = slide.points.map((p) => said(slide, p)).filter(Boolean);
  const buys = points.slice(0, 3);
  const close = points[3] ?? "";
  const lender = audience === "lender";
  const head = (text: string) => <span style={{ ...bodyStyle(theme, 20), fontWeight: 700, color: theme.accentText }}>{text}</span>;
  return (
    <Body gap={40}>
      <Headline theme={theme} size={48}>
        {said(slide, slide.headline)}
      </Headline>
      <div style={{ display: "flex", flexDirection: "row", gap: 64, alignItems: "flex-start" }}>
        {amount ? (
          <div style={{ display: "flex", flex: "none", maxWidth: 440 }}>
            <BigBlock theme={theme} block={amount} now={now} size={92} />
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 18, minWidth: 0 }}>
          {lender && buys.length ? head(SECTION_LABEL.use_of_funds) : null}
          <Points theme={theme} points={buys} size={26} />
        </div>
      </div>
      {close ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lender ? head(SECTION_LABEL.repayment) : null}
          <p style={{ ...bodyStyle(theme, 28), maxWidth: 1040 }}>{close}</p>
        </div>
      ) : null}
    </Body>
  );
}
