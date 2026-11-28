import { Bar, bodyStyle, headingStyle, said, type LayoutProps } from "./parts";

/** The cover: the logo large (or the brand's name), the deck's name and one line. */
export function Cover({ slide, theme, title }: LayoutProps) {
  const name = said(slide, slide.headline) || title;
  const line = slide.points.map((p) => said(slide, p)).find(Boolean) ?? "";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 36 }}>
      {theme.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={theme.logoUrl} alt={theme.brandName || name} style={{ maxHeight: 120, maxWidth: 480, objectFit: "contain", alignSelf: "flex-start" }} />
      ) : theme.brandName && theme.brandName !== name ? (
        <span style={{ ...headingStyle(theme, 34), color: theme.accentText }}>{theme.brandName}</span>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Bar theme={theme} />
        <h1 style={headingStyle(theme, 76)}>{name}</h1>
      </div>
      {line ? <p style={{ ...bodyStyle(theme, 32, true), maxWidth: 960 }}>{line}</p> : null}
    </div>
  );
}
