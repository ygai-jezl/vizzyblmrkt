import { describe, it, expect } from "vitest";
import { buttonColourSource, buttonPickerPatch, buttonSourcePatch, themeButtonShape } from "./buttonColour";
import { EmailLayoutSchema, type EmailBlock } from "@/lib/types/emailLayout";
import { renderEmailLayout } from "@/lib/email/emailRender";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import type { EmailThemePreset } from "@/lib/types/tenant";

const style = (over: Partial<ResolvedEmailStyle> = {}): ResolvedEmailStyle => ({
  logo: null,
  name: "Acme Co",
  altName: "Acme Co",
  headerColor: "#123456",
  accentColor: "#ffd400",
  layouts: true,
  ...over,
});
const theme = (preset: EmailThemePreset): ResolvedEmailStyle["theme"] => ({ preset, headingFont: "system", bodyFont: "system" });
// A saved style with layout buttons off: no `layouts` bit.
const { layouts: _bit, ...rest } = style();
const noLayouts: ResolvedEmailStyle = rest;

type Button = Extract<EmailBlock, { kind: "button" }>;
const built: Button = { id: "b1", kind: "button", label: "Get started", href: "https://example.com/start", align: "center", bg: "#4f46e5", color: "#ffffff", radius: 6 };
/** The editor's merge (updateBlock): a shallow patch over the block. */
const apply = (block: Button, patch: Partial<Button>): Button => ({ ...block, ...patch });

describe("a layout button's Colour switch", () => {
  it("shows only where layout buttons follow the Email style: none with the flag off or no style saved", () => {
    expect(buttonColourSource(built, null)).toBeNull();
    expect(buttonColourSource(built, undefined)).toBeNull();
    expect(buttonColourSource(built, noLayouts)).toBeNull();
    expect(buttonColourSource({ styleSource: "own" }, noLayouts)).toBeNull();
    expect(buttonColourSource(built, style())).toBe("email_style");
    expect(buttonColourSource({ styleSource: "email_style" }, style())).toBe("email_style");
    expect(buttonColourSource({ styleSource: "own" }, style())).toBe("own");
  });

  it("a picker change sets Own colour, so the picked colour is the one it draws", () => {
    expect(buttonPickerPatch({ bg: "#ff0000" }, style())).toEqual({ bg: "#ff0000", styleSource: "own" });
    expect(buttonPickerPatch({ color: "#000000" }, style({ theme: theme("modern") }))).toEqual({ color: "#000000", styleSource: "own" });
    const picked = apply(built, buttonPickerPatch({ bg: "#ff0000" }, style()));
    expect(buttonColourSource(picked, style())).toBe("own");
    expect(renderEmailLayout({ blocks: [picked] }, { style: style() })).toContain('<td style="background:#ff0000;border-radius:6px">');
  });

  it("flag off or no style saved: a picker writes its colour alone, no marker", () => {
    for (const s of [null, undefined, noLayouts, style({ layouts: undefined, theme: theme("modern") })]) {
      const patch = buttonPickerPatch({ bg: "#ff0000" }, s);
      expect(patch).toEqual({ bg: "#ff0000" });
      expect("styleSource" in patch).toBe(false);
      expect("styleSource" in apply(built, patch)).toBe(false);
    }
  });

  it("Own colour gives back the colours it was built with, and Email style follows again with no marker kept", () => {
    const own = apply(built, buttonSourcePatch("own"));
    expect(own).toEqual({ ...built, styleSource: "own" });
    expect(renderEmailLayout({ blocks: [own] }, { style: style() })).toBe(renderEmailLayout({ blocks: [built] }));
    const back = apply(own, buttonSourcePatch("email_style"));
    expect(back.styleSource).toBeUndefined();
    // As saved (JSON), it's the button as built: nothing about the switch is left behind.
    expect(EmailLayoutSchema.parse(JSON.parse(JSON.stringify({ blocks: [back] })))).toEqual({ blocks: [built] });
    expect(renderEmailLayout({ blocks: [back] }, { style: style() })).toContain('<td bgcolor="#ffd400"');
  });

  it("names the theme's button shape a following button takes; none with no theme", () => {
    expect(themeButtonShape(null)).toBeNull();
    expect(themeButtonShape(style())).toBeNull();
    expect(themeButtonShape(style({ theme: theme("modern") }))).toBe("pill");
    expect(themeButtonShape(style({ theme: theme("friendly") }))).toBe("pill");
    expect(themeButtonShape(style({ theme: theme("editorial") }))).toBe("square");
  });

  it("Classic, with any fonts, names none, so the button keeps its own corners and the Corner radius slider", () => {
    // BlockSettings shows the slider whenever this is null.
    for (const fonts of [{}, { bodyFont: "georgia" }, { headingFont: "lora", bodyFont: "inter" }] as const) {
      const s = style({ theme: { ...theme("classic")!, ...fonts } });
      expect(themeButtonShape(s)).toBeNull();
      expect(renderEmailLayout({ blocks: [built] }, { style: s })).toContain('<td bgcolor="#ffd400" style="background:#ffd400;border-radius:6px">');
    }
  });
});
