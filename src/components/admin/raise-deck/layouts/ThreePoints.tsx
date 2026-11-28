import { pointsCap } from "@/lib/raise/docs/layouts";
import { bodyStyle, Body, Headline, said, type LayoutProps } from "./parts";

/** A headline and up to three points side by side (four on a seed deck's product slide). */
export function ThreePoints({ slide, theme, stage }: LayoutProps) {
  const cap = pointsCap(slide.layout, slide.section, stage);
  const points = slide.points.map((p) => said(slide, p)).filter(Boolean).slice(0, cap);
  return (
    <Body gap={56}>
      <Headline theme={theme} size={50}>
        {said(slide, slide.headline)}
      </Headline>
      {points.length ? (
        <div style={{ display: "flex", flexDirection: "row", gap: 32 }}>
          {points.map((p, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16, borderTop: `4px solid ${theme.accent}`, paddingTop: 22 }}>
              <span style={{ ...bodyStyle(theme, 20), color: theme.accentText, fontWeight: 700 }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={bodyStyle(theme, points.length > 3 ? 24 : 27)}>{p}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Body>
  );
}
