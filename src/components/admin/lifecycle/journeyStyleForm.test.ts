import { describe, it, expect } from "vitest";
import {
  customJourneyStyle,
  draftForSave,
  isJourneyDraftCard,
  journeyBannerNote,
  journeyPreviewStyle,
  journeyStyleHints,
  logoSamplePath,
  publishConfirmText,
  readJourneyStyle,
  sameJourneyStyle,
  withJourneyGradient,
  withJourneyHeaderText,
  withSavedJourneyStyle,
} from "./journeyStyleForm";
import { emailStyleHints } from "../brand-kit/emailStyleForm";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { JourneyEmailStyleSchema } from "@/lib/types/tenant";
import { LifecycleDraftSchema, type LifecycleDraft } from "@/lib/types/lifecycle";

const LOGO = "https://app.example.com/api/brand-logo/ten_A/0f8fad5b-d9cb-469f-a165-70867728950e.png";
const brand: ResolvedEmailStyle = {
  logo: { url: LOGO, width: 120, height: 40 },
  name: null,
  altName: "Example Co",
  headerColor: "#0b1f3a",
  accentColor: "#ff6b35",
};
const NAVY = { headerColor: "#1e3a8a", accentColor: "#f97316" };
const palette = [
  { hex: "#1e3a8a", name: "Navy" },
  { hex: "#fde68a", name: "Sand" },
];

describe("readJourneyStyle", () => {
  it("reads a stored style, as the server does", () => {
    expect(readJourneyStyle(NAVY)).toStrictEqual(NAVY);
    expect(readJourneyStyle({ ...NAVY, headerGradientColor: "#4F46E5", headerText: "white" })).toStrictEqual({
      ...NAVY,
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
  });

  it("none, or colours that don't read, is the brand's; a damaged gradient or text drops alone", () => {
    for (const none of [undefined, null, "navy", {}, { headerColor: "navy", accentColor: "#f97316" }, { headerColor: "#1e3a8a" }]) {
      expect(readJourneyStyle(none)).toBeNull();
    }
    expect(readJourneyStyle({ ...NAVY, headerGradientColor: "teal", headerText: "auto", logo: null })).toEqual(NAVY);
  });
});

describe("sameJourneyStyle", () => {
  it("none is none, whatever form it takes", () => {
    for (const [a, b] of [
      [undefined, null],
      [null, undefined],
      [undefined, { headerColor: "navy" }],
    ] as Array<[unknown, unknown]>) {
      expect(sameJourneyStyle(a, b)).toBe(true);
    }
  });

  it("compares colours (in any case) and header text; none differs from a style", () => {
    expect(sameJourneyStyle(NAVY, { headerColor: "#1E3A8A", accentColor: "#F97316" })).toBe(true);
    expect(sameJourneyStyle(NAVY, null)).toBe(false);
    expect(sameJourneyStyle(undefined, NAVY)).toBe(false);
    expect(sameJourneyStyle(NAVY, { ...NAVY, accentColor: "#000000" })).toBe(false);
    expect(sameJourneyStyle(NAVY, { ...NAVY, headerGradientColor: "#4f46e5" })).toBe(false);
    expect(sameJourneyStyle(NAVY, { ...NAVY, headerText: "black" })).toBe(false);
    expect(sameJourneyStyle({ ...NAVY, headerText: "black" }, { ...NAVY, headerText: "black" })).toBe(true);
  });
});

describe("journeyPreviewStyle", () => {
  const opts = { fallbackName: "Example Co", headerOptions: true };

  it("no style, or one that doesn't read, is the brand's style itself", () => {
    for (const none of [undefined, null, { headerColor: "navy", accentColor: "#f97316" }]) {
      expect(journeyPreviewStyle(brand, none, opts)).toBe(brand);
    }
    expect(journeyPreviewStyle(null, undefined, opts)).toBeNull();
  });

  it("a Custom style draws its colours with the brand's logo, as at send", () => {
    expect(journeyPreviewStyle(brand, NAVY, opts)).toStrictEqual({ ...brand, ...NAVY });
    expect(journeyPreviewStyle(null, NAVY, opts)).toStrictEqual({ logo: null, name: null, altName: "Example Co", ...NAVY });
  });

  it("its gradient and header text draw only with header options", () => {
    const options = { ...NAVY, headerGradientColor: "#4f46e5", headerText: "white" };
    expect(journeyPreviewStyle(brand, options, opts)).toStrictEqual({ ...brand, ...options });
    expect(journeyPreviewStyle(brand, options, { ...opts, headerOptions: false })).toStrictEqual({ ...brand, ...NAVY });
  });
});

describe("customJourneyStyle", () => {
  it("starts from the journey's earlier Custom style", () => {
    const earlier = { ...NAVY, headerText: "black" as const };
    expect(customJourneyStyle(earlier, brand, true)).toStrictEqual(earlier);
  });

  it("else from the brand's colours, with its gradient and text only when header options draw them", () => {
    const options: ResolvedEmailStyle = { ...brand, headerGradientColor: "#4f46e5", headerText: "white" };
    expect(customJourneyStyle(null, brand, true)).toStrictEqual({ headerColor: "#0b1f3a", accentColor: "#ff6b35" });
    expect(customJourneyStyle(null, options, true)).toStrictEqual({
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    expect(customJourneyStyle(null, options, false)).toStrictEqual({ headerColor: "#0b1f3a", accentColor: "#ff6b35" });
  });

  it("else near-black, as today's emails", () => {
    expect(customJourneyStyle(null, null, true)).toStrictEqual({ headerColor: "#111111", accentColor: "#111111" });
  });

  it("whatever it starts from, the draft save accepts it", () => {
    const options: ResolvedEmailStyle = { ...brand, headerGradientColor: "#4f46e5", headerText: "white", layouts: true };
    for (const style of [customJourneyStyle(null, options, true), customJourneyStyle(null, null, false)]) {
      expect(JourneyEmailStyleSchema.safeParse(style).success).toBe(true);
    }
  });
});

describe("the gradient and header text controls", () => {
  it("ticking Gradient starts Colour 2 from the brand colours; unticking leaves no key", () => {
    const on = withJourneyGradient(NAVY, true, palette);
    expect(on).toStrictEqual({ ...NAVY, headerGradientColor: "#fde68a" });
    expect(withJourneyGradient(on, false, palette)).toStrictEqual(NAVY);
    expect(withJourneyGradient(NAVY, true, [])).toMatchObject({ headerGradientColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    expect(JourneyEmailStyleSchema.safeParse(on).success).toBe(true);
  });

  it("Auto is no key; White and Black are stored", () => {
    const white = withJourneyHeaderText(NAVY, "white");
    expect(white).toStrictEqual({ ...NAVY, headerText: "white" });
    expect(withJourneyHeaderText(white, "black")).toStrictEqual({ ...NAVY, headerText: "black" });
    expect(withJourneyHeaderText(white, "auto")).toStrictEqual(NAVY);
    expect(JourneyEmailStyleSchema.safeParse(white).success).toBe(true);
  });
});

describe("journeyStyleHints", () => {
  const DARK_INK = "#0a0a0a";

  it("warns about the brand's logo on a Custom header it's hard to see on", () => {
    const dark = { headerColor: "#111827", accentColor: "#f97316" };
    expect(journeyStyleHints(dark, brand, { logoInk: DARK_INK, headerOptions: false })[0]).toMatch(/logo is hard to see/);
    expect(journeyStyleHints({ ...dark, headerColor: "#ffffff" }, brand, { logoInk: DARK_INK, headerOptions: false })).not.toContainEqual(
      expect.stringMatching(/logo/),
    );
  });

  it("no logo check when the logo's colour isn't known, or the brand shows no logo", () => {
    const dark = { headerColor: "#111827", accentColor: "#f97316" };
    expect(journeyStyleHints(dark, brand, { logoInk: null, headerOptions: false })).not.toContainEqual(expect.stringMatching(/logo/));
    expect(journeyStyleHints(dark, { ...brand, logo: null }, { logoInk: DARK_INK, headerOptions: false })).not.toContainEqual(
      expect.stringMatching(/logo/),
    );
  });

  it("the Email style page's hints for the same colours: the header text with a name band, links, dark mode", () => {
    const light = { headerColor: "#fde68a", accentColor: "#fef3c7", headerText: "white" as const };
    const nameBand = { ...brand, logo: null };
    expect(journeyStyleHints(light, nameBand, { logoInk: null, headerOptions: true })).toStrictEqual(
      emailStyleHints({ logoBytes: null, logoInk: null, ...light, showsText: true }),
    );
    // White text is checked only when header options draw it; without them it's Auto.
    const hints = journeyStyleHints(light, nameBand, { logoInk: null, headerOptions: false });
    expect(hints).not.toContainEqual(expect.stringMatching(/White text/));
    expect(hints).toContainEqual(expect.stringMatching(/too light for text links/));
    expect(hints).toContainEqual(expect.stringMatching(/dark mode/));
  });
});

describe("journeyBannerNote", () => {
  it("only when the brand's emails use a header image", () => {
    expect(journeyBannerNote(brand)).toBeNull();
    expect(journeyBannerNote(null)).toBeNull();
    const banner = { ...brand, headerImage: { url: "https://app.example.com/banner.png", width: 1200, height: 300 } };
    expect(journeyBannerNote(banner)).toMatch(/logo on the header colour/);
    expect(journeyBannerNote({ ...banner, logo: null })).toMatch(/name on the header colour/);
  });
});

describe("logoSamplePath", () => {
  it("the logo's path on this site, for a brand logo URL only", () => {
    expect(logoSamplePath(LOGO)).toBe("/api/brand-logo/ten_A/0f8fad5b-d9cb-469f-a165-70867728950e.png");
    for (const other of [null, undefined, "", "not a url", "https://cdn.example.com/logo.png", "/api/brand-logo/ten_A/x.png"]) {
      expect(logoSamplePath(other)).toBeNull();
    }
  });
});

describe("what the draft save sends", () => {
  const draft = LifecycleDraftSchema.parse({ graph: { nodes: [], edges: [] }, pools: [], settings: {} }) as LifecycleDraft;

  it("a draft with no style key goes as it is: today's body", () => {
    expect(draftForSave(draft, false)).toBe(draft);
    expect(JSON.stringify(draftForSave(draft, true))).toBe(JSON.stringify(draft));
  });

  it("an untouched style is left out, so the stored one is kept; a touched one goes, null included", () => {
    const styled = { ...draft, settings: { ...draft.settings, emailStyle: NAVY } };
    const sent = draftForSave(styled, false);
    expect(sent.settings).not.toHaveProperty("emailStyle");
    expect(JSON.stringify(sent)).toBe(JSON.stringify(draft));
    expect(draftForSave(styled, true)).toBe(styled);
    const brandPicked = { ...draft, settings: { ...draft.settings, emailStyle: null } };
    expect(JSON.parse(JSON.stringify(draftForSave(brandPicked, true))).settings.emailStyle).toBeNull();
  });

  it("after a save, the editor holds the style that was saved", () => {
    const styled = { ...draft.settings, emailStyle: NAVY };
    expect(withSavedJourneyStyle(draft.settings, NAVY)).toStrictEqual(styled);
    expect(withSavedJourneyStyle(styled, undefined)).toStrictEqual(draft.settings);
    expect(withSavedJourneyStyle(styled, null)).not.toHaveProperty("emailStyle");
  });
});

describe("publishConfirmText", () => {
  it("is today's text when the email style hasn't changed", () => {
    expect(publishConfirmText({ publishedVersion: null, deliveryMode: "test" }, false)).toBe("Publish and start the journey in test mode?");
    expect(publishConfirmText({ publishedVersion: 2, deliveryMode: "live" }, false)).toBe(
      "Publish these changes? People already in the journey stay on the version they started with.",
    );
  });

  it("says everyone's next email wears a changed style; a first publish has no one in it yet", () => {
    expect(publishConfirmText({ publishedVersion: 2, deliveryMode: "live" }, true)).toBe(
      "Publish these changes? People already in the journey stay on the version they started with, and their next email uses the new email style.",
    );
    expect(publishConfirmText({ publishedVersion: null, deliveryMode: "shadow" }, true)).toBe("Publish and start the journey in shadow mode?");
  });
});

describe("isJourneyDraftCard (the editor's reload, from its docked chat or the Ask Vizzy panel)", () => {
  it("is a draft card of this journey: its style, Vizzy's edits, or a launch's welcome emails", () => {
    for (const kind of ["journey_style", "lifecycle", "journey"]) {
      expect(isJourneyDraftCard({ kind, id: "lcj_1" }, "lcj_1")).toBe(true);
      expect(isJourneyDraftCard({ kind, id: "lcj_2" }, "lcj_1")).toBe(false);
    }
  });

  it("isn't another kind's card, even one with the same id", () => {
    expect(isJourneyDraftCard({ kind: "email_style", id: "email_style" }, "lcj_1")).toBe(false);
    expect(isJourneyDraftCard({ kind: "content_plan", id: "lcj_1" }, "lcj_1")).toBe(false);
  });
});
