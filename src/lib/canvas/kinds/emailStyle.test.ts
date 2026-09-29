import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brandLogos = vi.hoisted(() => ({ listLogos: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => brandLogos);
const brandAssets = vi.hoisted(() => ({ listBrandAssets: vi.fn() }));
vi.mock("@/lib/admin/brandAssets", () => brandAssets);

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { authorEmailStyleSuggestion } from "./emailStyle";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_member", role: "member" };
const PNG = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const JPG = "7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const WEBP = "16fd2706-8baf-433b-82eb-8c7fada847da.webp";

const logo = (id: string, filename: string, mimeType: string, over: Partial<BrandLogo> = {}): BrandLogo => ({
  id,
  tenantId: "ten_A",
  filename,
  mimeType,
  title: `${id} file`,
  byteSize: 1000,
  isPrimary: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});
// Newest first, as listLogos returns them.
const LOGOS = [
  logo("logo_webp", WEBP, "image/webp", { createdAt: "2026-09-03T00:00:00.000Z" }),
  logo("logo_png", PNG, "image/png", { isPrimary: true, createdAt: "2026-09-02T00:00:00.000Z" }),
  logo("logo_jpg", JPG, "image/jpeg"),
];
const SAVED = {
  logo: { id: "logo_jpg", filename: JPG, width: 120, height: 40 },
  companyName: "Example Co",
  headerColor: "#222244",
  accentColor: "#00aa55",
  updatedAt: "2026-09-20T00:00:00.000Z",
  updatedBy: "usr_admin",
};
const PENDING = {
  logoId: "logo_png",
  companyName: "Pending Co",
  headerColor: "#333333",
  accentColor: "#cc0000",
  source: "chat",
  brief: "Make it red",
  notes: ["An earlier note"],
  suggestedBy: "usr_admin",
  suggestedAt: "2026-09-21T00:00:00.000Z",
};

function world(over: Record<string, unknown> = {}): FakeFirestore {
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
    brandKit: {
      palette: [
        { hex: "#0B1F3A", name: "Navy", role: "primary" },
        { hex: "#FF6B35", name: "Ember", role: "accent" },
      ],
    },
    ...over,
  });
  return db;
}
// Today's answers and stored suggestions, pinned whole (see the "pins today's" tests).
const PINNED_BRAND_KIT = {
  answer: {
    ok: true,
    id: "email_style",
    status: "suggested",
    url: "/admin/brand-kit/email-style",
    summary:
      "Suggested an Email style (header #0b1f3a, button #ff6b35, your logo). It's only a suggestion: " +
      "nothing changes until an admin reviews and saves it in Brand › Email style.",
    warnings: [],
    card: {
      kind: "email_style",
      id: "email_style",
      title: "Email style suggestion",
      url: "/admin/brand-kit/email-style",
      stats: [
        { label: "header", value: "#0b1f3a" },
        { label: "button", value: "#ff6b35" },
      ],
      warnings: 0,
      note: "Suggestion — nothing changes until an admin applies it.",
      cta: "Review and apply",
    },
  },
  suggestion: {
    logoId: "logo_png",
    companyName: null,
    headerColor: "#0b1f3a",
    accentColor: "#ff6b35",
    source: "brand_kit",
    brief: "Use my brand kit for my emails",
    notes: [],
    suggestedBy: "usr_admin",
    suggestedAt: expect.any(String),
  },
};
const PINNED_EDIT = {
  answer: {
    ok: true,
    id: "email_style",
    status: "suggested",
    url: "/admin/brand-kit/email-style",
    summary:
      'Suggested an Email style (header #000080, button #cc0000, your logo, the name "Pending Co"). ' +
      "It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Email style.",
    warnings: ["An earlier note"],
    card: {
      kind: "email_style",
      id: "email_style",
      title: "Email style suggestion",
      url: "/admin/brand-kit/email-style",
      stats: [
        { label: "header", value: "#000080" },
        { label: "button", value: "#cc0000" },
      ],
      warnings: 1,
      note: "Suggestion — nothing changes until an admin applies it.",
      cta: "Review and apply",
    },
  },
  suggestion: {
    logoId: "logo_png",
    companyName: "Pending Co",
    headerColor: "#000080",
    accentColor: "#cc0000",
    source: "chat",
    brief: "Make the header navy",
    notes: ["An earlier note"],
    suggestedBy: "usr_admin",
    suggestedAt: expect.any(String),
  },
};

const author = (db: FakeFirestore, input: Record<string, unknown>, ctx = admin, brief = "Use my brand kit for my emails") =>
  authorEmailStyleSuggestion({ ctx, input: { kind: "email_style", action: "save_draft", ...input }, brief }, { db });
const suggestionIn = (db: FakeFirestore) => db.raw("tenants", "ten_A")?.emailStyleSuggestion as Record<string, unknown> | undefined;

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
  // Off unless a test turns it on, whatever the shell has.
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
  vi.stubEnv("EMAIL_THEMES_ENABLED", "false");
  vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "false");
  brandLogos.listLogos.mockReset().mockResolvedValue(LOGOS);
  brandAssets.listBrandAssets.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("email_style canvas kind", () => {
  it("is unavailable while the flag is off, even for garbage input", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    const db = world();
    expect(await author(db, { mode: "nope", headerColor: 42 })).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    expect(await author(db, { mode: "brand_kit" }, member)).toMatchObject({ ok: false, status: 503 });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("is admin-only: a member, or a token without a role, gets 403", async () => {
    const db = world();
    expect(await author(db, { mode: "brand_kit" }, member)).toMatchObject({ ok: false, status: 403, error: "forbidden" });
    expect(await author(db, { mode: "brand_kit" }, { ...admin, role: undefined })).toMatchObject({ ok: false, status: 403 });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("refuses a bad colour with an issue the agent can fix", async () => {
    const db = world();
    const r = await author(db, { mode: "edit", headerColor: "navy" });
    expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    if (r.ok) throw new Error("expected a refusal");
    expect(r.issues).toEqual([expect.stringContaining("headerColor:")]);
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("refuses a WebP logo or one that isn't the tenant's", async () => {
    const db = world();
    expect(await author(db, { mode: "edit", logo: "logo_webp" })).toMatchObject({ ok: false, status: 400, error: "invalid_logo" });
    expect(await author(db, { mode: "edit", logo: "logo_other" })).toMatchObject({ ok: false, status: 400, error: "invalid_logo" });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("brand_kit: fills the suggestion from Brand, and never touches the saved style", async () => {
    const db = world({ emailStyle: SAVED });
    const r = await author(db, { mode: "brand_kit" });
    expect(r).toMatchObject({ ok: true, status: "suggested", warnings: [] });
    expect(suggestionIn(db)).toEqual({
      logoId: "logo_png",
      companyName: null,
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      source: "brand_kit",
      brief: "Use my brand kit for my emails",
      notes: [],
      suggestedBy: "usr_admin",
      suggestedAt: expect.any(String),
    });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("brand_kit: carries Brand's notes when there's no logo an email can use", async () => {
    brandLogos.listLogos.mockResolvedValue([]);
    const db = world();
    const r = await author(db, { mode: "brand_kit" });
    expect(r).toMatchObject({ ok: true, warnings: ["No logos yet — add a PNG or JPG in Brand › Logos"], card: { warnings: 1 } });
    expect(suggestionIn(db)).toMatchObject({ logoId: null, notes: ["No logos yet — add a PNG or JPG in Brand › Logos"] });
  });

  it("edit: the given fields go over the pending suggestion first", async () => {
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy");
    expect(suggestionIn(db)).toMatchObject({
      logoId: "logo_png",
      companyName: "Pending Co",
      headerColor: "#000080",
      accentColor: "#cc0000",
      source: "chat",
      brief: "Make the header navy",
      notes: ["An earlier note"],
    });
    expect(suggestionIn(db)?.suggestedAt).not.toBe(PENDING.suggestedAt);
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("edit: then over the saved style, normalising the colour", async () => {
    const db = world({ emailStyle: SAVED });
    await author(db, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(db)).toMatchObject({
      logoId: "logo_jpg",
      companyName: "Example Co",
      headerColor: "#222244",
      accentColor: "#aabbcc",
      source: "chat",
      notes: [],
    });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("edit: drops a carried-over logo that's since been deleted, and says so", async () => {
    const db = world({ emailStyleSuggestion: { ...PENDING, logoId: "logo_deleted" } });
    const r = await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy");
    const gone = "Your chosen logo is no longer available — pick another in Brand › Email style";
    expect(r).toMatchObject({ ok: true, warnings: [gone, "An earlier note"], card: { warnings: 2 } });
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.summary).toContain("no logo");
    expect(suggestionIn(db)).toMatchObject({ logoId: null, headerColor: "#000080", notes: [gone, "An earlier note"] });
  });

  it("edit: doesn't claim the saved logo while Logos is off", async () => {
    vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "false");
    const db = world({ emailStyle: SAVED });
    await author(db, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(db)).toMatchObject({ logoId: null, accentColor: "#aabbcc" });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("edit: then over Brand, and picks, hides or names as asked", async () => {
    const db = world();
    await author(db, { mode: "edit", companyName: "  Example⁣ Co  " });
    expect(suggestionIn(db)).toMatchObject({ logoId: "logo_png", companyName: "Example Co", headerColor: "#0b1f3a", accentColor: "#ff6b35" });
    await author(db, { mode: "edit", logo: "none", companyName: null });
    expect(suggestionIn(db)).toMatchObject({ logoId: null, companyName: null, headerColor: "#0b1f3a" });
    await author(db, { mode: "edit", logo: "primary" });
    expect(suggestionIn(db)).toMatchObject({ logoId: "logo_png" });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toBeUndefined();
  });

  it("never reports a suggestion that wouldn't read back", async () => {
    const db = world();
    const r = await author(db, { mode: "edit", companyName: "Hi {{user.first_name}}" });
    expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("clips a long brief, so a 4000-character ask still reads back (with a {{ in the tenant name too)", async () => {
    const db = world({ tenantName: "Example {{Co}}" });
    const r = await author(db, { mode: "brand_kit" }, admin, "x".repeat(4000));
    expect(r).toMatchObject({ ok: true });
    const tenant = await getTenantById("ten_A", db);
    expect(tenant?.emailStyleSuggestion).toBeDefined();
    expect(tenant?.emailStyleSuggestion?.brief).toHaveLength(500);
  });

  it("records who asked, or the agent when the token has no user", async () => {
    const db = world();
    await author(db, { mode: "brand_kit" });
    expect(suggestionIn(db)?.suggestedBy).toBe("usr_admin");
    await author(db, { mode: "brand_kit" }, { ...admin, userId: undefined });
    expect(suggestionIn(db)?.suggestedBy).toBe("agent");
  });

  it("answers with a Review and apply card for Brand › Email style", async () => {
    const r = await author(world(), { mode: "edit", headerColor: "#000080", buttonColor: "#FFD400" });
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.url).toBe("/admin/brand-kit/email-style");
    expect(r.summary).toContain("nothing changes until an admin");
    expect(r.card).toEqual({
      kind: "email_style",
      id: "email_style",
      title: "Email style suggestion",
      url: "/admin/brand-kit/email-style",
      stats: [
        { label: "header", value: "#000080" },
        { label: "button", value: "#ffd400" },
      ],
      warnings: 0,
      note: "Suggestion — nothing changes until an admin applies it.",
      cta: "Review and apply",
    });
  });

  // Pinned whole: with no header options, this is exactly what Vizzy answers and stores today.
  it("pins today's brand_kit answer and suggestion", async () => {
    const db = world({ emailStyle: SAVED });
    expect(await author(db, { mode: "brand_kit" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_BRAND_KIT.suggestion);
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("pins today's edit answer and suggestion", async () => {
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    expect(await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy")).toEqual(PINNED_EDIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  // Pinned whole: themes are coming to the kind behind a flag, and with it off, an edit from
  // Brand (nothing saved or suggested) and every refusal must stay exactly this.
  it("pins today's edit from Brand, with nothing saved or suggested", async () => {
    const db = world();
    const r = await author(db, { mode: "edit", buttonColor: "#FF6B35", logo: "none", companyName: "Example Co" }, admin, "Orange buttons");
    expect(r).toEqual({
      ...PINNED_BRAND_KIT.answer,
      summary:
        'Suggested an Email style (header #0b1f3a, button #ff6b35, no logo, the name "Example Co"). ' +
        "It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Email style.",
    });
    expect(suggestionIn(db)).toEqual({
      logoId: null,
      companyName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      source: "chat",
      brief: "Orange buttons",
      notes: [],
      suggestedBy: "usr_admin",
      suggestedAt: expect.any(String),
    });
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
  });

  it("pins today's refusals", async () => {
    const db = world();
    expect(await author(db, { mode: "brand_kit" }, member)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await author(db, { mode: "edit", headerColor: "navy" })).toEqual({
      ok: false,
      status: 400,
      error: "invalid_input",
      issues: ["headerColor: Use a #rrggbb colour"],
    });
    expect(await author(db, { mode: "edit", logo: "logo_webp" })).toEqual({
      ok: false,
      status: 400,
      error: "invalid_logo",
      issues: ["logo: that logo isn't a PNG or JPG, which Outlook needs — pick another"],
    });
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    expect(await author(db, { mode: "edit", headerColor: "#000080" })).toEqual({ ok: false, status: 503, error: "unavailable" });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("is rate-limited per tenant: the 6th in a burst gets 429", async () => {
    const db = world();
    for (let i = 0; i < 5; i += 1) expect(await author(db, { mode: "brand_kit" })).toMatchObject({ ok: true });
    expect(await author(db, { mode: "brand_kit" })).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
  });
});

describe("email_style canvas kind: header options", () => {
  const on = () => vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
  const OPTIONS = { headerGradientColor: "#4f46e5", headerText: "white" };

  it("flag off: a real colour 2 or a forced text colour is refused before anything is written or counted", async () => {
    const db = world({ emailStyle: SAVED });
    for (const input of [{ headerGradientColor: "#4f46e5" }, { headerText: "white" }, { headerText: "black" }]) {
      const r = await author(db, { mode: "edit", headerColor: "#7c3aed", ...input });
      expect(r).toEqual({
        ok: false,
        status: 400,
        error: "header_options_unavailable",
        issues: [
          "headerGradientColor/headerText/headerImage: gradient headers, header text colour and header images aren't switched on here yet",
        ],
      });
    }
    expect(suggestionIn(db)).toBeUndefined();
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
    // Checked before the rate limit, so the refusals didn't use up the burst.
    for (let i = 0; i < 3; i += 1) await author(db, { mode: "edit", headerGradientColor: "#4f46e5" });
    for (let i = 0; i < 5; i += 1) expect(await author(db, { mode: "brand_kit" })).toMatchObject({ ok: true });
  });

  it("flag off: the defaults (null, auto) are today's look, so the answer is exactly today's", async () => {
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    const defaults = { headerGradientColor: null, headerText: "auto" };
    expect(await author(db, { mode: "edit", headerColor: "#000080", ...defaults }, admin, "Make the header navy")).toEqual(
      PINNED_EDIT.answer,
    );
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    const kit = world({ emailStyle: SAVED });
    expect(await author(kit, { mode: "brand_kit", ...defaults })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
  });

  it("flag off: nothing is carried over from a pending suggestion or saved style that has options", async () => {
    const db = world({ emailStyle: { ...SAVED, ...OPTIONS }, emailStyleSuggestion: { ...PENDING, ...OPTIONS } });
    expect(await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy")).toEqual(PINNED_EDIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
  });

  it("flag on, with no options asked for or stored: exactly today's answers", async () => {
    on();
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    expect(await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy")).toEqual(PINNED_EDIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    const kit = world({ emailStyle: SAVED });
    expect(await author(kit, { mode: "brand_kit" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
  });

  it("flag on: a purple-to-indigo gradient with white text is stored, and the card and summary say so", async () => {
    on();
    const db = world({ emailStyle: SAVED });
    const r = await author(
      db,
      { mode: "edit", headerColor: "#7C3AED", headerGradientColor: "#4F46E5", headerText: "white" },
      admin,
      "Make the header a purple-to-indigo gradient with white text",
    );
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.summary).toBe(
      'Suggested an Email style (header #7c3aed fading to #4f46e5, white header text, button #00aa55, your logo, the name "Example Co"). ' +
        "It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Email style.",
    );
    expect(r.card.stats).toEqual([
      { label: "header", value: "#7c3aed → #4f46e5" },
      { label: "text", value: "white" },
      { label: "button", value: "#00aa55" },
    ]);
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#7c3aed", headerGradientColor: "#4f46e5", headerText: "white" });
    // It reads back through the strict schema, and the saved style is untouched.
    expect((await getTenantById("ten_A", db))?.emailStyleSuggestion).toMatchObject({
      headerColor: "#7c3aed",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  // Pinned whole: with the flag on, this is exactly what Vizzy answers and stores today.
  it("flag on: pins today's purple-to-indigo answer and suggestion", async () => {
    on();
    const db = world({ emailStyle: SAVED });
    const r = await author(
      db,
      { mode: "edit", headerColor: "#7C3AED", headerGradientColor: "#4F46E5", headerText: "white" },
      admin,
      "Make the header a purple-to-indigo gradient with white text",
    );
    expect(r).toEqual({
      ok: true,
      id: "email_style",
      status: "suggested",
      url: "/admin/brand-kit/email-style",
      summary:
        'Suggested an Email style (header #7c3aed fading to #4f46e5, white header text, button #00aa55, your logo, the name "Example Co"). ' +
        "It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Email style.",
      warnings: [],
      card: {
        kind: "email_style",
        id: "email_style",
        title: "Email style suggestion",
        url: "/admin/brand-kit/email-style",
        stats: [
          { label: "header", value: "#7c3aed → #4f46e5" },
          { label: "text", value: "white" },
          { label: "button", value: "#00aa55" },
        ],
        warnings: 0,
        note: "Suggestion — nothing changes until an admin applies it.",
        cta: "Review and apply",
      },
    });
    expect(suggestionIn(db)).toEqual({
      logoId: "logo_jpg",
      companyName: "Example Co",
      headerColor: "#7c3aed",
      accentColor: "#00aa55",
      headerGradientColor: "#4f46e5",
      headerText: "white",
      source: "chat",
      brief: "Make the header a purple-to-indigo gradient with white text",
      notes: [],
      suggestedBy: "usr_admin",
      suggestedAt: expect.any(String),
    });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("flag on: a forced text colour alone adds only the text stat", async () => {
    on();
    const r = await author(world(), { mode: "edit", headerColor: "#5b21b6", headerText: "black" });
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.card.stats).toEqual([
      { label: "header", value: "#5b21b6" },
      { label: "text", value: "black" },
      { label: "button", value: "#ff6b35" },
    ]);
    expect(r.summary).toContain("(header #5b21b6, black header text, button #ff6b35");
  });

  it("flag on: edit carries the options from the pending suggestion, then from the saved style", async () => {
    on();
    const fromPending = world({ emailStyle: SAVED, emailStyleSuggestion: { ...PENDING, ...OPTIONS } });
    await author(fromPending, { mode: "edit", buttonColor: "#00aa55" });
    expect(suggestionIn(fromPending)).toMatchObject({ headerColor: "#333333", accentColor: "#00aa55", ...OPTIONS });

    const fromSaved = world({ emailStyle: { ...SAVED, headerGradientColor: "#111166", headerText: "black" } });
    await author(fromSaved, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(fromSaved)).toMatchObject({
      headerColor: "#222244",
      headerGradientColor: "#111166",
      headerText: "black",
      accentColor: "#aabbcc",
    });
    expect(fromSaved.raw("tenants", "ten_A")?.emailStyle).toEqual({ ...SAVED, headerGradientColor: "#111166", headerText: "black" });
  });

  it("flag on: null makes the header solid and auto takes the text back to Auto", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, ...OPTIONS } });
    await author(db, { mode: "edit", headerGradientColor: null }, admin, "Make the header solid again");
    expect(suggestionIn(db)).toMatchObject({ headerText: "white" });
    expect(suggestionIn(db)).not.toHaveProperty("headerGradientColor");
    await author(db, { mode: "edit", headerText: "auto" });
    expect(suggestionIn(db)).not.toHaveProperty("headerText");
    expect(suggestionIn(db)).not.toHaveProperty("headerGradientColor");
  });

  it("flag on: brand_kit starts solid with Auto text, even over a style with options", async () => {
    on();
    const db = world({ emailStyle: { ...SAVED, ...OPTIONS }, emailStyleSuggestion: { ...PENDING, ...OPTIONS } });
    const r = await author(db, { mode: "brand_kit" });
    expect(r).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_BRAND_KIT.suggestion);
    // Asked-for options still go on top.
    await author(db, { mode: "brand_kit", headerGradientColor: "#4f46e5" });
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#0b1f3a", headerGradientColor: "#4f46e5" });
    expect(suggestionIn(db)).not.toHaveProperty("headerText");
  });

  it("flag on: a colour 2 equal to the header colour draws solid, so it isn't kept", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, headerGradientColor: "#4f46e5" } });
    await author(db, { mode: "edit", headerColor: "#4F46E5" });
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#4f46e5" });
    expect(suggestionIn(db)).not.toHaveProperty("headerGradientColor");
  });

  it("flag on: a saved colour 2 equal to its header colour is solid, so a new header colour doesn't make it a gradient", async () => {
    on();
    const db = world({ emailStyle: { ...SAVED, headerColor: "#7c3aed", headerGradientColor: "#7c3aed" } });
    const r = await author(db, { mode: "edit", headerColor: "#000080" });
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.summary).toContain("(header #000080, button");
    expect(r.card.stats[0]).toEqual({ label: "header", value: "#000080" });
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#000080" });
    expect(suggestionIn(db)).not.toHaveProperty("headerGradientColor");
  });

  it("refuses a bad colour 2 or text choice with an issue the agent can fix, flag on or off", async () => {
    for (const flag of ["true", "false"]) {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", flag);
      const db = world();
      const colour = await author(db, { mode: "edit", headerGradientColor: "indigo" });
      expect(colour).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
      if (colour.ok) throw new Error("expected a refusal");
      expect(colour.issues).toEqual([expect.stringContaining("headerGradientColor:")]);
      const text = await author(db, { mode: "edit", headerText: "pink" });
      expect(text).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
      expect(suggestionIn(db)).toBeUndefined();
    }
  });
});

describe("email_style canvas kind: header images", () => {
  const on = () => vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
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
    header("hdr_webp", "16fd2706-8baf-433b-82eb-8c7fada847da.webp", "image/webp"),
    header("icon_1", PNG, "image/png", { category: "icon" }),
    header("hdr_nosize", JPG, "image/jpeg", { width: undefined, height: undefined }),
  ];
  const GONE = "Your header image is no longer available — upload or pick one in Brand › Email style";
  const SAVED_IMAGE = { id: "hdr_autumn", filename: AUTUMN, width: 1200, height: 300 };
  const spring = (db: FakeFirestore, over: Record<string, unknown> = {}) =>
    author(db, { mode: "edit", headerImage: "hdr_spring", ...over }, admin, "Use my Spring banner as the email header");

  beforeEach(() => {
    brandAssets.listBrandAssets.mockResolvedValue(HEADERS);
  });

  it("flag off: an image id is refused before anything is read, written or counted", async () => {
    const db = world({ emailStyle: SAVED });
    const r = await spring(db);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "header_options_unavailable",
      issues: [
        "headerGradientColor/headerText/headerImage: gradient headers, header text colour and header images aren't switched on here yet",
      ],
    });
    expect(suggestionIn(db)).toBeUndefined();
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
    expect(brandAssets.listBrandAssets).not.toHaveBeenCalled();
    // Checked before the rate limit, so the refusals didn't use up the burst.
    for (let i = 0; i < 3; i += 1) await spring(db);
    for (let i = 0; i < 5; i += 1) expect(await author(db, { mode: "brand_kit" })).toMatchObject({ ok: true });
  });

  it('flag off: "none" is today\'s look, so the answer is exactly today\'s, and nothing is carried over', async () => {
    const db = world({
      emailStyle: { ...SAVED, headerImage: SAVED_IMAGE },
      emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_spring" },
    });
    expect(await author(db, { mode: "edit", headerColor: "#000080", headerImage: "none" }, admin, "Make the header navy")).toEqual(
      PINNED_EDIT.answer,
    );
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    const kit = world({ emailStyle: SAVED });
    expect(await author(kit, { mode: "brand_kit", headerImage: "none" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
    expect(brandAssets.listBrandAssets).not.toHaveBeenCalled();
  });

  it("flag on: an image id is stored, and the card and summary name the banner", async () => {
    on();
    const db = world({ emailStyle: SAVED });
    const r = await spring(db);
    expect(r).toEqual({
      ok: true,
      id: "email_style",
      status: "suggested",
      url: "/admin/brand-kit/email-style",
      summary:
        'Suggested an Email style (the header image "Spring banner" (#222244 behind it), button #00aa55, ' +
        'the name "Example Co" when images are off). It\'s only a suggestion: nothing changes until an admin reviews and ' +
        "saves it in Brand › Email style.",
      warnings: [],
      card: {
        kind: "email_style",
        id: "email_style",
        title: "Email style suggestion",
        url: "/admin/brand-kit/email-style",
        stats: [
          { label: "header", value: 'image "Spring banner"' },
          { label: "button", value: "#00aa55" },
        ],
        warnings: 0,
        note: "Suggestion — nothing changes until an admin applies it.",
        cta: "Review and apply",
      },
    });
    expect(suggestionIn(db)).toEqual({
      logoId: "logo_jpg",
      companyName: "Example Co",
      headerColor: "#222244",
      accentColor: "#00aa55",
      headerImageId: "hdr_spring",
      source: "chat",
      brief: "Use my Spring banner as the email header",
      notes: [],
      suggestedBy: "usr_admin",
      suggestedAt: expect.any(String),
    });
    expect(brandAssets.listBrandAssets).toHaveBeenCalledWith(admin, "header");
    // It reads back through the strict schema, and the saved style is untouched.
    expect((await getTenantById("ten_A", db))?.emailStyleSuggestion).toMatchObject({ headerImageId: "hdr_spring" });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("flag on: the gradient, text colour and logo stay alongside, for a switch back to Colour, but aren't claimed", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, headerGradientColor: "#4f46e5", headerText: "white" } });
    const r = await spring(db);
    if (!r.ok) throw new Error("expected a suggestion");
    // The banner ignores all three, so neither the words nor the card say they apply; the name
    // shows only when images are off (the banner's alt text).
    expect(r.card.stats).toEqual([
      { label: "header", value: 'image "Spring banner"' },
      { label: "button", value: "#cc0000" },
    ]);
    expect(r.summary).toContain(
      '(the header image "Spring banner" (#333333 behind it), button #cc0000, the name "Pending Co" when images are off).',
    );
    expect(r.summary).not.toContain("header text");
    expect(r.summary).not.toContain("logo");
    expect(suggestionIn(db)).toMatchObject({
      logoId: "logo_png",
      headerImageId: "hdr_spring",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });

    // Back on the colour header, all three are claimed again.
    const back = await author(db, { mode: "edit", headerImage: "none" }, admin, "Go back to the colour header");
    if (!back.ok) throw new Error("expected a suggestion");
    expect(back.card.stats).toEqual([
      { label: "header", value: "#333333 → #4f46e5" },
      { label: "text", value: "white" },
      { label: "button", value: "#cc0000" },
    ]);
    expect(back.summary).toContain(
      '(header #333333 fading to #4f46e5, white header text, button #cc0000, your logo, the name "Pending Co").',
    );
  });

  it("flag on: an image with no logo and no name claims neither", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, logoId: null, companyName: null } });
    const r = await spring(db);
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.summary).toContain('(the header image "Spring banner" (#333333 behind it), button #cc0000). ');
  });

  it('flag on: "none" goes back to the colour header', async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_spring" } });
    const r = await author(db, { mode: "edit", headerImage: "none" }, admin, "Go back to the colour header");
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.card.stats[0]).toEqual({ label: "header", value: "#333333" });
    expect(r.summary).toContain("(header #333333, button #cc0000");
    expect(suggestionIn(db)).not.toHaveProperty("headerImageId");
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#333333", notes: ["An earlier note"] });
  });

  it("flag on: edit carries the image from the pending suggestion, then from the saved style", async () => {
    on();
    const fromPending = world({ emailStyle: { ...SAVED, headerImage: SAVED_IMAGE }, emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_spring" } });
    const r = await author(fromPending, { mode: "edit", buttonColor: "#00aa55" });
    expect(r).toMatchObject({ ok: true, card: { stats: [{ label: "header", value: 'image "Spring banner"' }, { label: "button", value: "#00aa55" }] } });
    expect(suggestionIn(fromPending)).toMatchObject({ headerColor: "#333333", accentColor: "#00aa55", headerImageId: "hdr_spring" });

    const fromSaved = world({ emailStyle: { ...SAVED, headerImage: SAVED_IMAGE } });
    await author(fromSaved, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(fromSaved)).toMatchObject({ headerColor: "#222244", accentColor: "#aabbcc", headerImageId: "hdr_autumn", notes: [] });
    expect(fromSaved.raw("tenants", "ten_A")?.emailStyle).toEqual({ ...SAVED, headerImage: SAVED_IMAGE });
  });

  it("flag on: a carried-over image that's since been deleted is dropped, and says so", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_deleted" } });
    const r = await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy");
    expect(r).toMatchObject({ ok: true, warnings: [GONE, "An earlier note"], card: { warnings: 2 } });
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.card.stats[0]).toEqual({ label: "header", value: "#000080" });
    expect(suggestionIn(db)).not.toHaveProperty("headerImageId");
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#000080", notes: [GONE, "An earlier note"] });

    // A saved one that's no longer usable (a WebP) too; picking one afterwards drops the note.
    const saved = world({ emailStyle: { ...SAVED, headerImage: { ...SAVED_IMAGE, id: "hdr_webp" } } });
    await author(saved, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(saved)).toMatchObject({ notes: [GONE] });
    expect(suggestionIn(saved)).not.toHaveProperty("headerImageId");
    await spring(saved);
    expect(suggestionIn(saved)).toMatchObject({ headerImageId: "hdr_spring", notes: [] });
  });

  it("flag on: picking a logo drops the logo notes but keeps the header image's", async () => {
    on();
    const db = world({ emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_deleted" } });
    await author(db, { mode: "edit", headerColor: "#000080" });
    expect(suggestionIn(db)).toMatchObject({ notes: [GONE, "An earlier note"] });
    const r = await author(db, { mode: "edit", logo: "primary" }, admin, "Use my primary logo");
    expect(r).toMatchObject({ ok: true, warnings: [GONE], card: { warnings: 1 } });
    expect(suggestionIn(db)).toMatchObject({ logoId: "logo_png", notes: [GONE] });
    expect(suggestionIn(db)).not.toHaveProperty("headerImageId");
  });

  it("flag on: brand_kit starts on the colour header, even over a style with an image", async () => {
    on();
    const db = world({
      emailStyle: { ...SAVED, headerImage: SAVED_IMAGE },
      emailStyleSuggestion: { ...PENDING, headerImageId: "hdr_spring" },
    });
    expect(await author(db, { mode: "brand_kit" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_BRAND_KIT.suggestion);
    // An asked-for image still goes on top.
    await author(db, { mode: "brand_kit", headerImage: "hdr_autumn" });
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#0b1f3a", headerImageId: "hdr_autumn" });
  });

  it("flag on: an unknown id, or one that isn't a header image an email can use, is refused", async () => {
    on();
    for (const id of ["hdr_other", "hdr_webp", "icon_1", "hdr_nosize", "primary", "logo_png"]) {
      // Each is a counted attempt (it's checked after the rate limit), so start each afresh.
      __resetRateLimitState();
      const db = world({ emailStyle: SAVED });
      expect(await author(db, { mode: "edit", headerImage: id })).toEqual({
        ok: false,
        status: 400,
        error: "invalid_header_image",
        issues: ["headerImage: not one of your header images — upload one in Brand › Email style"],
      });
      expect(suggestionIn(db)).toBeUndefined();
    }
  });

  it("flag on: refuses a malformed id with an issue the agent can fix", async () => {
    on();
    const db = world();
    for (const headerImage of ["", "   ", "x".repeat(65), 42]) {
      const r = await author(db, { mode: "edit", headerImage });
      expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
      if (r.ok) throw new Error("expected a refusal");
      expect(r.issues).toEqual([expect.stringContaining("headerImage:")]);
    }
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("flag on: 503 when the header images can't be listed, with nothing written", async () => {
    on();
    brandAssets.listBrandAssets.mockRejectedValue(new Error("index building"));
    const db = world({ emailStyle: SAVED });
    expect(await author(db, { mode: "edit", headerColor: "#000080" })).toEqual({
      ok: false,
      status: 503,
      error: "header_images_unavailable",
    });
    expect(suggestionIn(db)).toBeUndefined();
  });

  it("flag on, with header images listed but none asked for or stored: exactly the answer with none", async () => {
    on();
    const ask = (db: FakeFirestore) =>
      author(
        db,
        { mode: "edit", headerColor: "#7C3AED", headerGradientColor: "#4F46E5", headerText: "white" },
        admin,
        "Make the header a purple-to-indigo gradient with white text",
      );
    const withImages = world({ emailStyle: SAVED });
    const answer = await ask(withImages);
    brandAssets.listBrandAssets.mockResolvedValue([]);
    const without = world({ emailStyle: SAVED });
    expect(answer).toEqual(await ask(without));
    const { suggestedAt: _a, ...a } = suggestionIn(withImages)!;
    const { suggestedAt: _b, ...b } = suggestionIn(without)!;
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty("headerImageId");
  });
});

describe("email_style canvas kind: themes", () => {
  const on = () => vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
  const THEMES_OFF = {
    ok: false,
    status: 400,
    error: "themes_unavailable",
    issues: ["theme/headingFont/bodyFont/useBrandFonts: email themes and fonts aren't switched on here yet"],
  };
  const EDITORIAL = { preset: "editorial", headingFont: "playfair-display" };
  // Brand › Fonts: a heading email has (Playfair Display), and a body font it doesn't.
  const TYPOGRAPHY = {
    styles: [
      { id: "ts_1", name: "Heading", role: "heading", fontFamily: "Playfair Display Bold" },
      { id: "ts_2", name: "Body", role: "body", fontFamily: "Example Sans" },
    ],
  };
  const NOT_FOR_TEXT = "“Example Sans” isn't available for email yet, so text keeps the current font";
  const tail = " It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Email style.";

  it("flag off: a real look, font or Brand fonts is refused before anything is read, written or counted", async () => {
    const db = world({ emailStyle: SAVED });
    for (const input of [
      { theme: "modern" },
      { theme: "classic", headingFont: "inter" },
      { bodyFont: "georgia" },
      { useBrandFonts: true },
    ]) {
      expect(await author(db, { mode: "edit", ...input })).toEqual(THEMES_OFF);
    }
    expect(brandLogos.listLogos).not.toHaveBeenCalled();
    expect(suggestionIn(db)).toBeUndefined();
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
    for (let i = 0; i < 5; i += 1) expect(await author(db, { mode: "brand_kit" })).toMatchObject({ ok: true });
  });

  it('flag off: "classic", the system font and no Brand fonts are today\'s look, so the answers are exactly today\'s', async () => {
    const today = { theme: "classic", headingFont: "system", bodyFont: "system", useBrandFonts: false };
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    expect(await author(db, { mode: "edit", headerColor: "#000080", ...today }, admin, "Make the header navy")).toEqual(
      PINNED_EDIT.answer,
    );
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    const kit = world({ emailStyle: SAVED });
    expect(await author(kit, { mode: "brand_kit", theme: "classic" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
  });

  it("flag off: nothing is carried over from a pending suggestion or saved style that has a theme", async () => {
    const db = world({
      emailStyle: { ...SAVED, theme: { preset: "modern" } },
      emailStyleSuggestion: { ...PENDING, theme: EDITORIAL, notes: [NOT_FOR_TEXT] },
    });
    expect(await author(db, { mode: "edit", headerColor: "#000080", logo: "primary" }, admin, "Make the header navy")).toEqual({
      ...PINNED_EDIT.answer,
      warnings: [],
      card: { ...PINNED_EDIT.answer.card, warnings: 0 },
    });
    expect(suggestionIn(db)).toEqual({ ...PINNED_EDIT.suggestion, notes: [] });
    const kit = world({ emailStyle: { ...SAVED, theme: { preset: "modern" } } });
    expect(await author(kit, { mode: "brand_kit" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
  });

  it("flag on, with no theme asked for or stored: exactly today's answers", async () => {
    on();
    vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
    const db = world({ emailStyle: SAVED, emailStyleSuggestion: PENDING });
    expect(await author(db, { mode: "edit", headerColor: "#000080" }, admin, "Make the header navy")).toEqual(PINNED_EDIT.answer);
    expect(suggestionIn(db)).toEqual(PINNED_EDIT.suggestion);
    const kit = world({ emailStyle: SAVED });
    expect(await author(kit, { mode: "brand_kit" })).toEqual(PINNED_BRAND_KIT.answer);
    expect(suggestionIn(kit)).toEqual(PINNED_BRAND_KIT.suggestion);
  });

  // Pinned whole: a look with its own fonts, with web fonts off.
  it("flag on: pins a Modern answer and suggestion", async () => {
    on();
    const db = world({ emailStyle: SAVED });
    expect(await author(db, { mode: "edit", theme: "modern" }, admin, "Make my emails feel more modern")).toEqual({
      ok: true,
      id: "email_style",
      status: "suggested",
      url: "/admin/brand-kit/email-style",
      summary:
        'Suggested an Email style (header #222244, button #00aa55, theme Modern (Inter / Inter), your logo, the name "Example Co"). ' +
        "Web fonts aren't switched on yet, so every inbox shows Segoe UI or Helvetica in place of Inter." +
        tail,
      warnings: [],
      card: {
        kind: "email_style",
        id: "email_style",
        title: "Email style suggestion",
        url: "/admin/brand-kit/email-style",
        stats: [
          { label: "header", value: "#222244" },
          { label: "button", value: "#00aa55" },
          { label: "theme", value: "Modern (Inter / Inter)" },
        ],
        warnings: 0,
        note: "Suggestion — nothing changes until an admin applies it.",
        cta: "Review and apply",
      },
    });
    expect(suggestionIn(db)).toEqual({
      logoId: "logo_jpg",
      companyName: "Example Co",
      headerColor: "#222244",
      accentColor: "#00aa55",
      theme: { preset: "modern" },
      source: "chat",
      brief: "Make my emails feel more modern",
      notes: [],
      suggestedBy: "usr_admin",
      suggestedAt: expect.any(String),
    });
    // It reads back, and the saved style is untouched.
    expect((await getTenantById("ten_A", db))?.emailStyleSuggestion?.theme).toEqual({ preset: "modern" });
    expect(db.raw("tenants", "ten_A")?.emailStyle).toEqual(SAVED);
  });

  it("flag on: with web fonts on, says which inboxes show them and what the rest show", async () => {
    on();
    vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
    const cases: Array<[string, string]> = [
      ["modern", " Inter shows in Apple Mail and Outlook for Mac; Gmail, Outlook.com and most other inboxes show Segoe UI or Helvetica instead."],
      ["editorial", " Lora shows in Apple Mail and Outlook for Mac; Gmail, Outlook.com and most other inboxes show Georgia instead."],
      [
        "friendly",
        " Poppins and Nunito show in Apple Mail and Outlook for Mac; Gmail, Outlook.com and most other inboxes show Segoe UI or Helvetica instead.",
      ],
    ];
    for (const [theme, line] of cases) {
      __resetRateLimitState();
      const r = await author(world({ emailStyle: SAVED }), { mode: "edit", theme });
      if (!r.ok) throw new Error("expected a suggestion");
      expect(r.summary).toContain(`).${line} It's only a suggestion`);
    }
    // Safe fonts only: nothing to say.
    const safe = await author(world({ emailStyle: SAVED }), { mode: "edit", theme: "modern", headingFont: "arial", bodyFont: "verdana" });
    if (!safe.ok) throw new Error("expected a suggestion");
    expect(safe.summary).toContain('theme Modern (Arial / Verdana), your logo, the name "Example Co").' + tail);
  });

  it("flag on: fonts go over the look's own, and only differing ones are stored", async () => {
    on();
    const db = world({ emailStyle: SAVED });
    const r = await author(db, { mode: "edit", theme: "editorial", headingFont: "playfair-display" });
    expect(r).toMatchObject({ ok: true, card: { stats: [{}, {}, { label: "theme", value: "Editorial (Playfair Display / Georgia)" }] } });
    expect(suggestionIn(db)?.theme).toEqual(EDITORIAL);
    await author(db, { mode: "edit", theme: "editorial", headingFont: "lora", bodyFont: "georgia" });
    expect(suggestionIn(db)?.theme).toEqual({ preset: "editorial" });
    // A font alone keeps the look carried over (here, the pending Editorial).
    await author(db, { mode: "edit", bodyFont: "arial" });
    expect(suggestionIn(db)?.theme).toEqual({ preset: "editorial", bodyFont: "arial" });
    // A look alone brings its own fonts.
    await author(db, { mode: "edit", theme: "friendly" });
    expect(suggestionIn(db)?.theme).toEqual({ preset: "friendly" });
  });

  it("flag on: edit carries the theme from the pending suggestion, then from the saved style", async () => {
    on();
    const fromPending = world({ emailStyle: { ...SAVED, theme: { preset: "modern" } }, emailStyleSuggestion: { ...PENDING, theme: EDITORIAL } });
    const r = await author(fromPending, { mode: "edit", buttonColor: "#00aa55" });
    expect(r).toMatchObject({ ok: true, card: { stats: [{}, {}, { label: "theme", value: "Editorial (Playfair Display / Georgia)" }] } });
    expect(suggestionIn(fromPending)).toMatchObject({ headerColor: "#333333", accentColor: "#00aa55", theme: EDITORIAL });

    const fromSaved = world({ emailStyle: { ...SAVED, theme: { preset: "modern", bodyFont: "lora" } } });
    await author(fromSaved, { mode: "edit", buttonColor: "#ABC" });
    expect(suggestionIn(fromSaved)).toMatchObject({ accentColor: "#aabbcc", theme: { preset: "modern", bodyFont: "lora" } });
    expect(fromSaved.raw("tenants", "ten_A")?.emailStyle).toEqual({ ...SAVED, theme: { preset: "modern", bodyFont: "lora" } });
  });

  it('flag on: "classic" takes the theme away, and the answer says so', async () => {
    on();
    const db = world({ emailStyle: { ...SAVED, theme: { preset: "modern" } } });
    const r = await author(db, { mode: "edit", theme: "classic" }, admin, "Go back to the classic look");
    if (!r.ok) throw new Error("expected a suggestion");
    expect(r.summary).toBe(
      'Suggested an Email style (header #222244, button #00aa55, theme Classic (System / System), your logo, the name "Example Co").' +
        tail,
    );
    expect(r.card.stats).toContainEqual({ label: "theme", value: "Classic (System / System)" });
    expect(suggestionIn(db)).not.toHaveProperty("theme");
    // Classic with other fonts is a theme.
    await author(db, { mode: "edit", theme: "classic", bodyFont: "georgia" });
    expect(suggestionIn(db)?.theme).toEqual({ preset: "classic", bodyFont: "georgia" });
  });

  it("flag on: brand_kit keeps the saved theme, not the pending one; an asked-for look goes on top", async () => {
    on();
    const db = world({ emailStyle: { ...SAVED, theme: { preset: "modern" } }, emailStyleSuggestion: { ...PENDING, theme: EDITORIAL } });
    const r = await author(db, { mode: "brand_kit" });
    expect(r).toMatchObject({ ok: true, card: { stats: [{ value: "#0b1f3a" }, { value: "#ff6b35" }, { label: "theme", value: "Modern (Inter / Inter)" }] } });
    expect(suggestionIn(db)).toMatchObject({ headerColor: "#0b1f3a", source: "brand_kit", theme: { preset: "modern" } });
    await author(db, { mode: "brand_kit", theme: "friendly" });
    expect(suggestionIn(db)?.theme).toEqual({ preset: "friendly" });
  });

  it("flag on: useBrandFonts takes Brand's fonts where email has them, and says which it can't", async () => {
    on();
    const db = world({ emailStyle: { ...SAVED, theme: { preset: "modern" } }, brandTypography: TYPOGRAPHY });
    const r = await author(db, { mode: "edit", useBrandFonts: true }, admin, "Use my brand fonts in emails");
    expect(r).toMatchObject({
      ok: true,
      warnings: [NOT_FOR_TEXT],
      card: { stats: [{}, {}, { label: "theme", value: "Modern (Playfair Display / Inter)" }], warnings: 1 },
    });
    expect(suggestionIn(db)).toMatchObject({ theme: { preset: "modern", headingFont: "playfair-display" }, notes: [NOT_FOR_TEXT] });

    // Picking a logo keeps the font note; a font picked afterwards replaces it.
    await author(db, { mode: "edit", logo: "primary" });
    expect(suggestionIn(db)).toMatchObject({ logoId: "logo_png", notes: [NOT_FOR_TEXT] });
    await author(db, { mode: "edit", bodyFont: "georgia" });
    expect(suggestionIn(db)).toMatchObject({ theme: { preset: "modern", headingFont: "playfair-display", bodyFont: "georgia" }, notes: [] });

    // A font given with it wins; with both given, Brand isn't asked.
    await author(db, { mode: "edit", useBrandFonts: true, headingFont: "lora" });
    expect(suggestionIn(db)).toMatchObject({ theme: { preset: "modern", headingFont: "lora", bodyFont: "georgia" }, notes: [NOT_FOR_TEXT] });
    await author(db, { mode: "edit", useBrandFonts: true, headingFont: "inter", bodyFont: "inter" });
    expect(suggestionIn(db)).toMatchObject({ theme: { preset: "modern" }, notes: [] });
  });

  it("flag on: useBrandFonts with no brand fonts keeps the fonts, with a note", async () => {
    on();
    __resetRateLimitState();
    const db = world({ emailStyle: SAVED });
    const r = await author(db, { mode: "edit", useBrandFonts: true });
    expect(r).toMatchObject({ ok: true, warnings: ["No brand fonts yet — add text styles in Brand › Fonts"] });
    expect(suggestionIn(db)).not.toHaveProperty("theme");
  });

  it("refuses an unknown look or font with an issue the agent can fix, flag on or off", async () => {
    for (const flag of ["false", "true"]) {
      vi.stubEnv("EMAIL_THEMES_ENABLED", flag);
      const db = world();
      for (const [input, field] of [
        [{ theme: "brutalist" }, "theme:"],
        [{ theme: "Modern" }, "theme:"],
        [{ headingFont: "comic-sans" }, "headingFont:"],
        [{ bodyFont: "'Inter',sans-serif" }, "bodyFont:"],
        [{ useBrandFonts: "yes" }, "useBrandFonts:"],
      ] as const) {
        const r = await author(db, { mode: "edit", ...input });
        expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
        if (r.ok) throw new Error("expected a refusal");
        expect(r.issues).toEqual([expect.stringContaining(field)]);
      }
      expect(suggestionIn(db)).toBeUndefined();
    }
  });
});
