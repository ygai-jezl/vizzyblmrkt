import { describe, it, expect } from "vitest";
import { PRESET_EMAIL_TEMPLATES } from "./presetTemplates";
import { EmailLayoutSchema, MAX_EMAIL_BLOCKS } from "@/lib/types/emailLayout";
import { renderEmailLayout } from "@/lib/email/emailRender";

describe("PRESET_EMAIL_TEMPLATES", () => {
  it("exposes at least the welcome starter with unique preset ids", () => {
    expect(PRESET_EMAIL_TEMPLATES.length).toBeGreaterThan(0);
    const ids = PRESET_EMAIL_TEMPLATES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("welcome-onboarding");
  });

  for (const preset of PRESET_EMAIL_TEMPLATES) {
    describe(preset.id, () => {
      it("is a schema-valid layout within the block cap", () => {
        expect(() => EmailLayoutSchema.parse(preset.layout)).not.toThrow();
        expect(preset.layout.blocks.length).toBeLessThanOrEqual(MAX_EMAIL_BLOCKS);
        expect(preset.title.trim()).not.toBe("");
        expect(preset.description.trim()).not.toBe("");
      });

      it("has unique block ids and at most one AI copy block", () => {
        const ids = preset.layout.blocks.map((b) => b.id);
        expect(new Set(ids).size).toBe(ids.length);
        const copy = preset.layout.blocks.filter((b) => b.role === "copy");
        expect(copy.length).toBeLessThanOrEqual(1);
        // A designated copy block must be text (only text carries regenerated AI copy).
        if (copy.length === 1) expect(copy[0]!.kind).toBe("text");
      });

      it("renders to email-safe HTML (no live script, merge tokens verbatim)", () => {
        const html = renderEmailLayout(preset.layout);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/javascript:/i);
      });
    });
  }

  it("welcome-onboarding matches the GitLab-modelled block structure", () => {
    const welcome = PRESET_EMAIL_TEMPLATES.find((p) => p.id === "welcome-onboarding")!;
    const kinds = welcome.layout.blocks.map((b) => b.kind);
    expect(kinds).toEqual([
      "image", // header / logo
      "heading", // welcome headline
      "text", // subtitle (AI copy)
      "button", // primary CTA
      "image", // hero
      "heading", // "3 tips" section header (smaller)
      "text", // tips
      "button", // secondary CTA
      "heading", // help section header (smaller)
      "text", // help copy
      "footer",
    ]);
    // The headline is H1; both section headers are the smaller H2 the user described.
    const headings = welcome.layout.blocks.filter((b) => b.kind === "heading");
    expect(headings.map((h) => (h.kind === "heading" ? h.level : null))).toEqual([1, 2, 2]);
    // The intro/subtitle is the designated AI copy target, and product name merges through.
    const html = renderEmailLayout(welcome.layout);
    expect(html).toContain("{{waitlist_name}}");
    expect(html).toContain("{{first_name}}");
    expect(html).toContain("Unsubscribe"); // footer mock button
  });
});
