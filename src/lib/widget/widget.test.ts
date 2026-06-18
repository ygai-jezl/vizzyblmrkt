import { describe, it, expect } from "vitest";
import {
  parseWidgetType,
  parseWidgetMode,
  parseThemeOverrides,
  safeColor,
  widgetVariant,
} from "./types";
import { buildEmbedUrl, buildEmbedSnippet } from "./snippet";

describe("parseWidgetType", () => {
  it("accepts the three known types case-insensitively", () => {
    expect(parseWidgetType("WIDGET_1")).toBe("WIDGET_1");
    expect(parseWidgetType("widget_2")).toBe("WIDGET_2");
    expect(parseWidgetType(" WIDGET_3 ")).toBe("WIDGET_3");
  });
  it("falls back to WIDGET_1 for anything unknown or missing", () => {
    expect(parseWidgetType(null)).toBe("WIDGET_1");
    expect(parseWidgetType(undefined)).toBe("WIDGET_1");
    expect(parseWidgetType("WIDGET_9")).toBe("WIDGET_1");
    expect(parseWidgetType("'><script>")).toBe("WIDGET_1");
  });
  it("maps types to layout variants", () => {
    expect(widgetVariant("WIDGET_1")).toBe("full");
    expect(widgetVariant("WIDGET_2")).toBe("mini");
    expect(widgetVariant("WIDGET_3")).toBe("docked");
  });
});

describe("parseWidgetMode", () => {
  it("only recognizes CHECK; everything else is SIGNUP", () => {
    expect(parseWidgetMode("CHECK")).toBe("CHECK");
    expect(parseWidgetMode("check")).toBe("CHECK");
    expect(parseWidgetMode("SIGNUP")).toBe("SIGNUP");
    expect(parseWidgetMode(null)).toBe("SIGNUP");
    expect(parseWidgetMode("nonsense")).toBe("SIGNUP");
  });
});

describe("safeColor (CSS-injection guard)", () => {
  it("accepts valid 3/6/8-digit hex", () => {
    expect(safeColor("#fff")).toBe("#fff");
    expect(safeColor("#112233")).toBe("#112233");
    expect(safeColor("#11223344")).toBe("#11223344");
  });
  it("rejects non-hex and injection attempts", () => {
    expect(safeColor("red")).toBeUndefined();
    expect(safeColor("rgb(0,0,0)")).toBeUndefined();
    expect(safeColor("#fff;background:url(x)")).toBeUndefined();
    expect(safeColor("</style><script>")).toBeUndefined();
    expect(safeColor("")).toBeUndefined();
    expect(safeColor(null)).toBeUndefined();
  });
  it("parseThemeOverrides keeps only valid colors", () => {
    const q = new Map<string, string>([
      ["buttonColor", "#000000"],
      ["bgColor", "javascript:alert(1)"],
      ["fontColor", "#abc"],
    ]);
    expect(parseThemeOverrides((k) => q.get(k))).toEqual({
      buttonColor: "#000000",
      fontColor: "#abc",
    });
  });
});

describe("buildEmbedUrl", () => {
  it("always includes the widget type and encodes the campaign id", () => {
    expect(
      buildEmbedUrl({ origin: "https://app.vizzybl.ai", campaignId: "beta-launch" }),
    ).toBe("https://app.vizzybl.ai/embed/beta-launch?type=WIDGET_1");
  });
  it("adds the tenant id as ?t= when provided", () => {
    const url = buildEmbedUrl({
      origin: "https://yougrow.ai",
      campaignId: "c1",
      tenantId: "ten_acme",
    });
    expect(url).toContain("t=ten_acme");
    expect(url).toContain("type=WIDGET_1");
  });
  it("adds mode, ref, and validated theme colors", () => {
    const url = buildEmbedUrl({
      origin: "https://app.vizzybl.ai/",
      campaignId: "c1",
      widgetType: "WIDGET_2",
      mode: "CHECK",
      ref: "tok_abc",
      theme: { buttonColor: "#111827", backgroundColor: "#ffffff" },
    });
    expect(url).toContain("/embed/c1?");
    expect(url).toContain("type=WIDGET_2");
    expect(url).toContain("mode=CHECK");
    expect(url).toContain("ref=tok_abc");
    expect(url).toContain("buttonColor=%23111827");
    expect(url).toContain("bgColor=%23ffffff");
    // trailing slash on origin is normalized (no double slash)
    expect(url.startsWith("https://app.vizzybl.ai/embed/")).toBe(true);
  });
});

describe("buildEmbedSnippet", () => {
  it("emits a container div + async loader script", () => {
    const snippet = buildEmbedSnippet({
      origin: "https://app.vizzybl.ai",
      campaignId: "beta-launch",
      widgetType: "WIDGET_3",
    });
    expect(snippet).toContain('data-vizzybl-campaign="beta-launch"');
    expect(snippet).toContain('data-vizzybl-type="WIDGET_3"');
    expect(snippet).toContain('<script src="https://app.vizzybl.ai/embed.js" async>');
  });
  it("adds the tenant attribute only when a tenant id is provided", () => {
    expect(
      buildEmbedSnippet({ origin: "https://x", campaignId: "c" }),
    ).not.toContain("data-vizzybl-tenant");
    expect(
      buildEmbedSnippet({ origin: "https://x", campaignId: "c", tenantId: "ten_acme" }),
    ).toContain('data-vizzybl-tenant="ten_acme"');
  });
  it("adds the CHECK mode attribute only when requested", () => {
    expect(
      buildEmbedSnippet({ origin: "https://x", campaignId: "c", mode: "SIGNUP" }),
    ).not.toContain("data-vizzybl-mode");
    expect(
      buildEmbedSnippet({ origin: "https://x", campaignId: "c", mode: "CHECK" }),
    ).toContain('data-vizzybl-mode="CHECK"');
  });
  it("HTML-escapes attribute values to prevent snippet injection", () => {
    const snippet = buildEmbedSnippet({
      origin: "https://x",
      campaignId: 'evil" onload="alert(1)',
    });
    expect(snippet).not.toContain('onload="alert(1)"');
    expect(snippet).toContain("&quot;");
  });
});
