import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brandLogos = vi.hoisted(() => ({ listLogos: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => brandLogos);
const brandAssets = vi.hoisted(() => ({ listBrandAssets: vi.fn() }));
vi.mock("@/lib/admin/brandAssets", () => brandAssets);

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { agentEmailStyle, emailStyleAgentGate } from "./agentApi";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_member", role: "member" };
const PNG = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const WEBP = "16fd2706-8baf-433b-82eb-8c7fada847da.webp";
const row = (id: string, filename: string, mimeType: string, isPrimary: boolean) => ({
  id,
  tenantId: "ten_A",
  filename,
  mimeType,
  title: `${id} file`,
  byteSize: 1000,
  isPrimary,
  createdAt: "2026-09-01T00:00:00.000Z",
});
const req = (token?: string) =>
  new Request("https://app.example.com/api/agent/email-style", { headers: token ? { "x-canvas-context": token } : {} });

/** `over` adds to the saved style and the pending suggestion (e.g. header options). */
function world(over: { emailStyle?: Record<string, unknown>; emailStyleSuggestion?: Record<string, unknown> } = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    brandKit: { palette: [{ hex: "#0b1f3a", name: "Navy", role: "primary" }] },
    emailSenderConfig: {
      senderName: "Ada at Example",
      fromLocalPart: "ada",
      fromDomain: "example.com",
      replyTo: "ada@example.com",
      postalAddress: "1 High Street, London",
      privacyPolicyUrl: "https://example.com/privacy",
      domains: [],
    },
    emailStyle: {
      logo: { id: "logo_png", filename: PNG, width: 120, height: 40 },
      companyName: null,
      headerColor: "#222244",
      accentColor: "#00aa55",
      updatedAt: "2026-09-20T00:00:00.000Z",
      updatedBy: "usr_saver",
      ...over.emailStyle,
    },
    emailStyleSuggestion: {
      logoId: null,
      companyName: "Example Co",
      headerColor: "#000080",
      accentColor: "#00aa55",
      source: "chat",
      brief: "Make the header navy",
      notes: [],
      suggestedBy: "usr_asker",
      suggestedAt: "2026-09-21T00:00:00.000Z",
      ...over.emailStyleSuggestion,
    },
  });
  return db;
}

// Today's full answer for world(), pinned whole (see "pins today's full answer").
const PINNED = {
  status: 200,
  body: {
    url: "/admin/brand-kit/email-style",
    canSuggest: true,
    current: {
      logo: { id: "logo_png", title: "logo_png file" },
      companyName: null,
      headerColor: "#222244",
      buttonColor: "#00aa55",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
    pending: {
      logo: null,
      companyName: "Example Co",
      headerColor: "#000080",
      buttonColor: "#00aa55",
      source: "chat",
      brief: "Make the header navy",
      notes: [],
      suggestedAt: "2026-09-21T00:00:00.000Z",
    },
    fromBrandKit: {
      logo: { id: "logo_png", title: "logo_png file" },
      companyName: null,
      headerColor: "#0b1f3a",
      buttonColor: "#0b1f3a",
      notes: [],
    },
    logos: [{ id: "logo_png", title: "logo_png file", primary: true, format: "png" }],
    note: "companyName null shows the logo alone. A suggestion changes nothing until an admin saves it on the page.",
  },
};

beforeEach(() => {
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
  // Off unless a test turns it on, whatever the shell has.
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
  vi.stubEnv("EMAIL_THEMES_ENABLED", "false");
  vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "false");
  vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "false");
  brandLogos.listLogos.mockReset().mockResolvedValue([row("logo_webp", WEBP, "image/webp", false), row("logo_png", PNG, "image/png", true)]);
  brandAssets.listBrandAssets.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's Email style read", () => {
  it("is off with the flag, before the token is checked; then needs a valid token", () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    expect(emailStyleAgentGate(req())).toMatchObject({ ok: false, result: { status: 503, body: { error: "unavailable" } } });
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    expect(emailStyleAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(emailStyleAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(emailStyleAgentGate(req(signCanvasContext(admin)))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A", role: "admin" } });
  });

  it("returns the saved style, the pending suggestion, Brand's pick and the usable logos", async () => {
    const r = await agentEmailStyle(admin, world());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      url: "/admin/brand-kit/email-style",
      canSuggest: true,
      current: { logo: { id: "logo_png", title: "logo_png file" }, companyName: null, headerColor: "#222244", buttonColor: "#00aa55" },
      pending: { logo: null, companyName: "Example Co", headerColor: "#000080", source: "chat", suggestedAt: "2026-09-21T00:00:00.000Z" },
      fromBrandKit: { logo: { id: "logo_png" }, headerColor: "#0b1f3a", notes: [] },
      logos: [{ id: "logo_png", title: "logo_png file", primary: true, format: "png" }],
    });
  });

  // Pinned whole: with no header options, this is exactly what Vizzy reads today.
  it("pins today's full answer", async () => {
    const r = await agentEmailStyle(admin, world());
    expect(r).toEqual(PINNED);
  });

  // Pinned whole: themes and layout buttons will add fields only with their flags on. With nothing
  // saved or suggested, this is exactly what Vizzy reads today, with the header options off and on.
  it("pins today's full answer with nothing saved or suggested", async () => {
    const db = world();
    db.seed("tenants", "ten_A", { ...db.raw("tenants", "ten_A"), emailStyle: undefined, emailStyleSuggestion: undefined });
    const bare = {
      url: "/admin/brand-kit/email-style",
      canSuggest: true,
      current: null,
      pending: null,
      fromBrandKit: PINNED.body.fromBrandKit,
      logos: PINNED.body.logos,
    };
    expect(await agentEmailStyle(admin, db)).toEqual({ status: 200, body: { ...bare, note: PINNED.body.note } });
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    expect(await agentEmailStyle(admin, db)).toEqual({
      status: 200,
      body: {
        url: bare.url,
        canSuggest: true,
        headerOptions: true,
        current: null,
        pending: null,
        fromBrandKit: bare.fromBrandKit,
        logos: bare.logos,
        headerImages: [],
        note:
          "companyName null shows the logo alone. A suggestion changes nothing until an admin saves it on the page. " +
          "headerGradientColor fades the header from headerColor to it, top left to bottom right (null = solid; " +
          "Outlook and Gmail on Android show headerColor alone), and headerText is auto (black or white, whichever " +
          "reads better), white or black. headerImage replaces the logo and name with a banner uploaded on the page " +
          "(null = the colour header; headerColor stays behind it and shows when images are off). Suggest one by its " +
          'id from headerImages, or "none"; only the page can upload one.',
      },
    });
  });

  it("tells a member they can't suggest", async () => {
    expect((await agentEmailStyle(member, world())).body).toMatchObject({ canSuggest: false });
  });

  it("carries no people: not who asked, who saved, or an address", async () => {
    for (const flag of ["false", "true"]) {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", flag);
      const json = JSON.stringify((await agentEmailStyle(admin, world())).body);
      expect(json).not.toContain("suggestedBy");
      expect(json).not.toContain("updatedBy");
      expect(json).not.toContain("usr_");
      expect(json).not.toContain("@");
      expect(json).not.toContain("Ada");
    }
  });
});

describe("Vizzy's Email style read: header options", () => {
  const OPTIONS = {
    emailStyle: { headerGradientColor: "#4f46e5", headerText: "white" },
    emailStyleSuggestion: { headerGradientColor: "#4f46e5", headerText: "black" },
  };

  it("flag off: exactly today's answer, even with options saved and suggested", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const r = await agentEmailStyle(admin, world(OPTIONS));
    expect(r).toEqual(PINNED);
    expect(JSON.stringify(r.body)).not.toMatch(/headerGradientColor|headerText|headerOptions/);
  });

  it("flag on: says so, and gives the saved and pending options", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const r = await agentEmailStyle(admin, world(OPTIONS));
    expect(r.body).toMatchObject({
      headerOptions: true,
      current: { headerColor: "#222244", headerGradientColor: "#4f46e5", headerText: "white", buttonColor: "#00aa55" },
      pending: { headerColor: "#000080", headerGradientColor: "#4f46e5", headerText: "black", buttonColor: "#00aa55" },
      fromBrandKit: PINNED.body.fromBrandKit,
    });
    const { note } = r.body as { note: string };
    expect(note.startsWith(PINNED.body.note)).toBe(true);
    expect(note).toContain("headerGradientColor");
    expect(note).toContain("Outlook");
  });

  // Pinned whole: with the flag on, this is exactly what Vizzy reads (with no header images yet).
  it("flag on: pins today's full answer", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    expect(await agentEmailStyle(admin, world(OPTIONS))).toEqual({
      status: 200,
      body: {
        url: "/admin/brand-kit/email-style",
        canSuggest: true,
        headerOptions: true,
        current: {
          logo: { id: "logo_png", title: "logo_png file" },
          companyName: null,
          headerColor: "#222244",
          headerGradientColor: "#4f46e5",
          headerText: "white",
          headerImage: null,
          buttonColor: "#00aa55",
          updatedAt: "2026-09-20T00:00:00.000Z",
        },
        pending: {
          logo: null,
          companyName: "Example Co",
          headerColor: "#000080",
          headerGradientColor: "#4f46e5",
          headerText: "black",
          headerImage: null,
          buttonColor: "#00aa55",
          source: "chat",
          brief: "Make the header navy",
          notes: [],
          suggestedAt: "2026-09-21T00:00:00.000Z",
        },
        fromBrandKit: {
          logo: { id: "logo_png", title: "logo_png file" },
          companyName: null,
          headerColor: "#0b1f3a",
          buttonColor: "#0b1f3a",
          notes: [],
        },
        logos: [{ id: "logo_png", title: "logo_png file", primary: true, format: "png" }],
        headerImages: [],
        note:
          "companyName null shows the logo alone. A suggestion changes nothing until an admin saves it on the page. " +
          "headerGradientColor fades the header from headerColor to it, top left to bottom right (null = solid; " +
          "Outlook and Gmail on Android show headerColor alone), and headerText is auto (black or white, whichever " +
          "reads better), white or black. headerImage replaces the logo and name with a banner uploaded on the page " +
          "(null = the colour header; headerColor stays behind it and shows when images are off). Suggest one by its " +
          'id from headerImages, or "none"; only the page can upload one.',
      },
    });
  });

  it("flag on with no options: the defaults are spelled out (null = solid, auto, null = the colour header)", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const { body } = (await agentEmailStyle(admin, world())) as { body: typeof PINNED.body };
    const defaults = { headerGradientColor: null, headerText: "auto", headerImage: null };
    expect(body.current).toEqual({ ...PINNED.body.current, ...defaults });
    expect(body.pending).toEqual({ ...PINNED.body.pending, ...defaults });
    expect(body.fromBrandKit).toEqual(PINNED.body.fromBrandKit);
  });

  it("flag on: a colour 2 equal to the header colour draws solid, so it reads as null", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const equal = { emailStyle: { headerGradientColor: "#222244" }, emailStyleSuggestion: { headerGradientColor: "#000080" } };
    const { body } = (await agentEmailStyle(admin, world(equal))) as { body: typeof PINNED.body };
    expect(body.current).toMatchObject({ headerColor: "#222244", headerGradientColor: null });
    expect(body.pending).toMatchObject({ headerColor: "#000080", headerGradientColor: null });
  });
});

describe("Vizzy's Email style read: header images", () => {
  const SPRING = "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg";
  const AUTUMN = "9b2c7d4e-1a3f-4b5c-8d6e-7f8091a2b3c4.png";
  const header = (id: string, filename: string, mimeType: string, over: Record<string, unknown> = {}) => ({
    id,
    tenantId: "ten_A",
    category: "header",
    filename,
    mimeType,
    title: `${id} title`,
    byteSize: 50_000,
    width: 1200,
    height: 300,
    createdAt: "2026-09-10T00:00:00.000Z",
    ...over,
  });
  // Newest first, as listBrandAssets returns them; the last three aren't header images an email can use.
  const HEADERS = [
    header("hdr_spring", SPRING, "image/jpeg", { title: "Spring banner", createdAt: "2026-09-12T00:00:00.000Z" }),
    header("hdr_autumn", AUTUMN, "image/png", { title: "Autumn banner" }),
    header("hdr_webp", WEBP, "image/webp"),
    header("icon_1", PNG, "image/png", { category: "icon" }),
    header("hdr_nosize", SPRING, "image/jpeg", { width: undefined, height: undefined }),
  ];
  const IMAGES = {
    emailStyle: { headerImage: { id: "hdr_autumn", filename: AUTUMN, width: 1200, height: 300 } },
    emailStyleSuggestion: { headerImageId: "hdr_spring" },
  };
  beforeEach(() => {
    brandAssets.listBrandAssets.mockResolvedValue(HEADERS);
  });

  it("flag off: exactly today's answer, with nothing listed, even with an image saved and suggested", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const r = await agentEmailStyle(admin, world(IMAGES));
    expect(r).toEqual(PINNED);
    expect(JSON.stringify(r.body)).not.toMatch(/headerImage|hdr_/);
    expect(brandAssets.listBrandAssets).not.toHaveBeenCalled();
  });

  it("flag on: lists the usable header images newest first, and names the saved and suggested ones", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const r = await agentEmailStyle(admin, world(IMAGES));
    expect(brandAssets.listBrandAssets).toHaveBeenCalledWith(admin, "header");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.headerImages).toEqual([
      { id: "hdr_spring", title: "Spring banner" },
      { id: "hdr_autumn", title: "Autumn banner" },
    ]);
    expect(body.current).toMatchObject({ headerImage: { id: "hdr_autumn", title: "Autumn banner" }, headerColor: "#222244" });
    expect(body.pending).toMatchObject({ headerImage: { id: "hdr_spring", title: "Spring banner" }, headerColor: "#000080" });
  });

  it("flag on: a suggested image that's since been deleted keeps its id, with no title", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const { body } = (await agentEmailStyle(admin, world({ emailStyleSuggestion: { headerImageId: "hdr_deleted" } }))) as {
      body: Record<string, unknown>;
    };
    expect(body.pending).toMatchObject({ headerImage: { id: "hdr_deleted", title: null } });
    expect(body.current).toMatchObject({ headerImage: null });
  });

  it("flag on: 503 when the header images can't be listed", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    brandAssets.listBrandAssets.mockRejectedValue(new Error("index building"));
    expect(await agentEmailStyle(admin, world())).toEqual({ status: 503, body: { error: "header_images_unavailable" } });
  });

  it("carries no people or tenant data with images listed: not who asked, who saved, or the rows' tenant", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const json = JSON.stringify((await agentEmailStyle(admin, world(IMAGES))).body);
    expect(json).not.toContain("suggestedBy");
    expect(json).not.toContain("updatedBy");
    expect(json).not.toContain("usr_");
    expect(json).not.toContain("ten_A");
    expect(json).not.toContain(SPRING);
    expect(json).not.toContain("@");
  });
});

describe("Vizzy's Email style read: themes", () => {
  const THEMES = {
    emailStyle: { theme: { preset: "modern", bodyFont: "lora" } },
    emailStyleSuggestion: { theme: { preset: "editorial", headingFont: "playfair-display" } },
  };
  const THEME_NOTE =
    " theme is a look from themePresets with a heading and a body font from fonts (by id): a look brings its own fonts " +
    "unless fonts are picked too, and useBrandFonts takes them from Brand › Fonts where email has them. Outlook for " +
    "Windows draws the corners and buttons square.";
  const PRESETS = [
    { id: "classic", label: "Classic", headingFont: "system", bodyFont: "system", page: "#f6f6f6", card: "square", buttons: "rounded" },
    { id: "modern", label: "Modern", headingFont: "inter", bodyFont: "inter", page: "#f3f4f6", card: "rounded", buttons: "pill" },
    { id: "editorial", label: "Editorial", headingFont: "lora", bodyFont: "georgia", page: "#f7f3ec", card: "square", buttons: "square" },
    {
      id: "friendly",
      label: "Friendly",
      headingFont: "poppins",
      bodyFont: "nunito",
      page: "a light tint of the button colour",
      card: "rounded",
      buttons: "pill",
    },
  ];
  const FONTS = [
    { id: "system", label: "System", kind: "safe", fallback: null },
    { id: "arial", label: "Arial", kind: "safe", fallback: null },
    { id: "georgia", label: "Georgia", kind: "safe", fallback: null },
    { id: "verdana", label: "Verdana", kind: "safe", fallback: null },
    { id: "trebuchet", label: "Trebuchet MS", kind: "safe", fallback: null },
    { id: "inter", label: "Inter", kind: "web", fallback: "Segoe UI or Helvetica" },
    { id: "poppins", label: "Poppins", kind: "web", fallback: "Segoe UI or Helvetica" },
    { id: "nunito", label: "Nunito", kind: "web", fallback: "Segoe UI or Helvetica" },
    { id: "montserrat", label: "Montserrat", kind: "web", fallback: "Segoe UI or Helvetica" },
    { id: "lora", label: "Lora", kind: "web", fallback: "Georgia" },
    { id: "playfair-display", label: "Playfair Display", kind: "web", fallback: "Georgia" },
  ];

  it("flag off: exactly today's answer, even with a theme saved and suggested", async () => {
    vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
    const r = await agentEmailStyle(admin, world(THEMES));
    expect(r).toEqual(PINNED);
    expect(JSON.stringify(r.body)).not.toMatch(/theme|font/i);
  });

  // Pinned whole: with the flag on (web fonts off), this is exactly what Vizzy reads.
  it("flag on: pins the full answer, with the fonts filled in", async () => {
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    expect(await agentEmailStyle(admin, world(THEMES))).toEqual({
      status: 200,
      body: {
        ...PINNED.body,
        themes: true,
        current: { ...PINNED.body.current, theme: { preset: "modern", headingFont: "inter", bodyFont: "lora" } },
        pending: { ...PINNED.body.pending, theme: { preset: "editorial", headingFont: "playfair-display", bodyFont: "georgia" } },
        themePresets: PRESETS,
        fonts: FONTS,
        note: PINNED.body.note + THEME_NOTE + " Web fonts aren't switched on yet, so every inbox shows a web font's fallback.",
      },
    });
  });

  it("flag on: no theme reads as Classic with the system font, and a damaged font as the look's own", async () => {
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    const classic = { preset: "classic", headingFont: "system", bodyFont: "system" };
    const plain = (await agentEmailStyle(admin, world())).body as typeof PINNED.body & Record<string, unknown>;
    expect(plain.current).toEqual({ ...PINNED.body.current, theme: classic });
    expect(plain.pending).toEqual({ ...PINNED.body.pending, theme: classic });
    const damaged = world({ emailStyle: { theme: { preset: "friendly", headingFont: "comic-sans" } } });
    expect(((await agentEmailStyle(admin, damaged)).body as Record<string, unknown>).current).toMatchObject({
      theme: { preset: "friendly", headingFont: "poppins", bodyFont: "nunito" },
    });
  });

  it("flag on: with web fonts on too, only the note changes", async () => {
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    const off = (await agentEmailStyle(admin, world(THEMES))).body as { note: string };
    vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
    const on = (await agentEmailStyle(admin, world(THEMES))).body as { note: string };
    expect(on).toEqual({
      ...off,
      note:
        PINNED.body.note +
        THEME_NOTE +
        " A web font shows only in Apple Mail, Outlook for Mac and a few other inboxes; Gmail, Outlook.com and the rest show its fallback.",
    });
  });

  it("flag on with the header options on too: both sets of fields, and both notes", async () => {
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const body = (await agentEmailStyle(admin, world(THEMES))).body as Record<string, unknown> & { note: string };
    expect(body).toMatchObject({ headerOptions: true, themes: true, headerImages: [], themePresets: PRESETS, fonts: FONTS });
    expect(body.current).toMatchObject({ headerGradientColor: null, theme: { preset: "modern" } });
    expect(body.note).toContain("headerImage replaces the logo");
    expect(body.note).toContain(THEME_NOTE);
  });
});

describe("Vizzy's Email style read: layout buttons", () => {
  const LAYOUTS_NOTE =
    " buttonColor also colours the buttons in Create email layouts, except a button set to its own colour " +
    "(only the layout editor can set that).";

  it("flag off: exactly today's answer", async () => {
    const r = await agentEmailStyle(admin, world());
    expect(r).toEqual(PINNED);
    expect(JSON.stringify(r.body)).not.toMatch(/layouts|Create email layouts/);
  });

  // Pinned whole: with the flag on, only `layouts` and one sentence of the note are new.
  it("flag on: pins the full answer", async () => {
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    const r = await agentEmailStyle(admin, world());
    expect(r).toEqual({ status: 200, body: { ...PINNED.body, layouts: true, note: PINNED.body.note + LAYOUTS_NOTE } });
    expect(Object.keys(r.body as object)).toEqual([
      "url",
      "canSuggest",
      "layouts",
      "current",
      "pending",
      "fromBrandKit",
      "logos",
      "note",
    ]);
  });

  it("flag on with themes and the header options: every field, and the layouts sentence last", async () => {
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const on = (await agentEmailStyle(admin, world())).body as Record<string, unknown> & { note: string };
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "false");
    const off = (await agentEmailStyle(admin, world())).body as Record<string, unknown> & { note: string };
    expect(on).toMatchObject({ headerOptions: true, themes: true, layouts: true });
    const { layouts: _bit, ...rest } = on;
    expect({ ...rest, note: off.note }).toEqual(off);
    expect(on.note).toBe(off.note + LAYOUTS_NOTE);
  });

  it("a member reads it too, still with no people", async () => {
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    const body = (await agentEmailStyle(member, world())).body;
    expect(body).toMatchObject({ canSuggest: false, layouts: true });
    const json = JSON.stringify(body);
    expect(json).not.toContain("usr_");
    expect(json).not.toContain("@");
  });
});
