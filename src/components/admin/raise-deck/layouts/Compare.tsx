import { RAISE_DOC_LIMITS } from "@/lib/raise/docs/types";
import { bodyStyle, Body, Headline, said, type LayoutProps } from "./parts";

/** A headline and two columns, such as what people do today against what this business does, up to 4 rows. */
export function Compare({ slide, theme }: LayoutProps) {
  const c = slide.compare;
  const rows = (c?.rows ?? []).slice(0, RAISE_DOC_LIMITS.compareRows).map((r) => ({ left: said(slide, r.left), right: said(slide, r.right) }));
  const column = (title: string, cells: string[], strong: boolean) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        gap: 0,
        borderRadius: 16,
        padding: "26px 32px",
        background: strong ? theme.surface : theme.ground,
        border: strong ? `3px solid ${theme.accent}` : `2px solid ${theme.surface}`,
      }}
    >
      <span style={{ ...bodyStyle(theme, 22), fontWeight: 700, color: strong ? theme.accentText : theme.muted, marginBottom: 12 }}>{title}</span>
      {cells.map((cell, i) => (
        <span key={i} style={{ ...bodyStyle(theme, 25), padding: "12px 0", borderTop: i ? `1px solid #E4E4E0` : "none" }}>
          {cell}
        </span>
      ))}
    </div>
  );
  return (
    <Body gap={44}>
      <Headline theme={theme} size={46}>
        {said(slide, slide.headline)}
      </Headline>
      {c ? (
        <div style={{ display: "flex", flexDirection: "row", gap: 32 }}>
          {column(c.leftTitle, rows.map((r) => r.left), false)}
          {column(c.rightTitle, rows.map((r) => r.right), true)}
        </div>
      ) : null}
    </Body>
  );
}
