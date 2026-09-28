import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brandLogos = vi.hoisted(() => ({ listLogos: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => brandLogos);

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
  brandLogos.listLogos.mockReset().mockResolvedValue([row("logo_webp", WEBP, "image/webp", false), row("logo_png", PNG, "image/png", true)]);
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

  it("flag on with no options: the defaults are spelled out (null = solid, auto)", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const { body } = (await agentEmailStyle(admin, world())) as { body: typeof PINNED.body };
    expect(body.current).toEqual({ ...PINNED.body.current, headerGradientColor: null, headerText: "auto" });
    expect(body.pending).toEqual({ ...PINNED.body.pending, headerGradientColor: null, headerText: "auto" });
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
