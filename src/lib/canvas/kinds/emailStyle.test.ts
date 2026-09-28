import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brandLogos = vi.hoisted(() => ({ listLogos: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => brandLogos);

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
  brandLogos.listLogos.mockReset().mockResolvedValue(LOGOS);
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
        issues: ["headerGradientColor/headerText: gradient headers and header text colour aren't switched on here yet"],
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
