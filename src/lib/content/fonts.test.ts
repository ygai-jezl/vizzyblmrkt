import { describe, it, expect } from "vitest";
import { sanitizeFontFamily, fontStackFor, roleLabel, seededTextStyles } from "./fonts";

describe("sanitizeFontFamily (CSS-injection guard for the @font-face sink)", () => {
  it("strips characters that could break out of a CSS string / <style> element", () => {
    // newline → CSS bad-string; `</style>` → HTML breakout; `{};'\"` → rule/quote breakout
    expect(sanitizeFontFamily("A\n};body{background:url(//evil)}")).toBe("A bodybackgroundurlevil");
    expect(sanitizeFontFamily("foo</style><img src=x onerror=alert(1)>.woff2")).toBe(
      "foostyleimg srcx onerroralert1woff2",
    );
    expect(sanitizeFontFamily("Ma'lice\"; }")).toBe("Malice");
  });

  it("keeps ordinary family names intact", () => {
    expect(sanitizeFontFamily("Playfair Display")).toBe("Playfair Display");
    expect(sanitizeFontFamily("Space_Grotesk-Bold")).toBe("Space_Grotesk-Bold");
    expect(sanitizeFontFamily("  Inter  ")).toBe("Inter");
  });

  it("clamps to 80 chars and collapses whitespace", () => {
    expect(sanitizeFontFamily("a".repeat(200)).length).toBe(80);
    expect(sanitizeFontFamily("A    B")).toBe("A B");
  });
});

describe("fonts helpers", () => {
  it("fontStackFor resolves curated families and quotes custom ones", () => {
    expect(fontStackFor("Inter")).toContain("Inter");
    expect(fontStackFor("My Brand Font")).toContain("'My Brand Font'");
    expect(fontStackFor(null)).toContain("system-ui");
  });

  it("roleLabel maps camelCase roles to human labels", () => {
    expect(roleLabel("sectionHeader")).toBe("Section header");
    expect(roleLabel("title")).toBe("Title");
  });

  it("seededTextStyles returns the 8 default rows with unique ids", () => {
    const s = seededTextStyles();
    expect(s).toHaveLength(8);
    expect(new Set(s.map((x) => x.id)).size).toBe(8);
    expect(s[0]?.role).toBe("title");
  });
});
