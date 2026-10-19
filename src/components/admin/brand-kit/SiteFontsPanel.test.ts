import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFontsPanel } from "./SiteFontsPanel";
import type { SiteFonts } from "@/lib/types/imageStyle";

const html = (initial: SiteFonts | null) =>
  renderToStaticMarkup(createElement(SiteFontsPanel, { initial, domain: "example.com", onUpload: () => {} }));
const at = { domain: "example.com", detectedAt: "2026-10-19T12:00:00.000Z" };

describe("SiteFontsPanel", () => {
  it("before a check, offers one", () => {
    const out = html(null);
    expect(out).toContain("Check my site");
    expect(out).toContain("Not checked yet");
  });

  it("says why each role uses its family", () => {
    const out = html({
      ...at,
      heading: { family: "Source Serif 4", detected: "Tiempos Headline", source: "match" },
      body: { family: "Work Sans", detected: "Work Sans", source: "google" },
    });
    expect(out).toContain("Closest free match for Tiempos Headline");
    expect(out).toContain("From Google Fonts");
    expect(out).toContain("Check again");
  });

  it("a system font site, and a site with no fonts", () => {
    const sys = { family: "Roboto", detected: null, source: "match" as const };
    expect(html({ ...at, heading: sys, body: sys, systemOnly: true })).toContain("Your site uses system fonts");
    expect(html({ ...at, heading: null, body: null })).toContain("No fonts named on your site");
  });
});
