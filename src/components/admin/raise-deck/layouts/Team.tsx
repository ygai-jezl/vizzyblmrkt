import { RAISE_DOC_LIMITS } from "@/lib/raise/docs/types";
import { bodyStyle, Body, Headline, headingStyle, initialsOf, said, type LayoutProps } from "./parts";

/** A headline and up to 4 people: initials in a circle, name, role and one line. No photos. */
export function Team({ slide, theme }: LayoutProps) {
  const people = (slide.people ?? []).slice(0, RAISE_DOC_LIMITS.people);
  return (
    <Body gap={56}>
      <Headline theme={theme} size={46}>
        {said(slide, slide.headline)}
      </Headline>
      {people.length ? (
        <div style={{ display: "flex", flexDirection: "row", gap: 36 }}>
          {people.map((p, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", flex: 1, gap: 12, minWidth: 0 }}>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  background: theme.accent,
                  color: theme.accentInk,
                  ...headingStyle(theme, 34),
                  lineHeight: 1,
                }}
              >
                <span style={{ color: theme.accentInk }}>{initialsOf(p.name)}</span>
              </span>
              <span style={{ ...bodyStyle(theme, 26), fontWeight: 700 }}>{p.name}</span>
              <span style={bodyStyle(theme, 20, true)}>{p.role}</span>
              <span style={bodyStyle(theme, 20)}>{p.line}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Body>
  );
}
