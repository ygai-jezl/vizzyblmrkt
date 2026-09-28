import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › Email style: flag, then sign-in, then admin; a strict parse; the logo must be
// this tenant's PNG/JPEG. Save and Reset write only `tenant.emailStyle` (Save may also clear
// the suggestion it applies).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const logos = vi.hoisted(() => ({ getLogo: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => logos);
const assets = vi.hoisted(() => ({ getBrandAsset: vi.fn() }));
vi.mock("@/lib/admin/brandAssets", () => assets);
const control = vi.hoisted(() => ({
  setTenantEmailStyle: vi.fn(async (_id: string, style: unknown) => (style ? { ...style, updatedAt: "2026-09-27T00:00:00.000Z" } : null)),
  clearTenantEmailStyleHeaderImage: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant/control", () => control);

const { PUT, DELETE } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const logoRow = {
  id: "logo_1",
  tenantId: "ten_A",
  filename: FILE,
  mimeType: "image/png",
  title: "Logo",
  byteSize: 1000,
  isPrimary: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const style = {
  logo: { id: "logo_1", filename: FILE, width: 120, height: 40 },
  companyName: null,
  headerColor: "#0b1f3a",
  accentColor: "#ff6b35",
};
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/email-style", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  logos.getLogo.mockResolvedValue(logoRow);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/brand-kit/email-style", () => {
  it("503s with the flag off, before anything else", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "");
    const res = await PUT(req("PUT", style));
    expect(res.status).toBe(503);
    expect((await DELETE(req("DELETE"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req("PUT", style))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", style))).status).toBe(403);
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad hex", { ...style, headerColor: "navy" }],
    ["a short hex", { ...style, accentColor: "#abc" }],
    ["{{ in the name", { ...style, companyName: "Hi {{user.first_name}}" }],
    ["*| in the name", { ...style, companyName: "*|FNAME|* Co" }],
    ["< in the name", { ...style, companyName: "<b>Example</b>" }],
    ["a WebP filename", { ...style, logo: { ...style.logo, filename: FILE.replace(".png", ".webp") } }],
    ["no body", undefined],
  ])("400s for %s", async (_label, body) => {
    const res = await PUT(req("PUT", body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", issues: expect.any(Array) });
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("400s for a logo that isn't this tenant's, or whose file doesn't match", async () => {
    logos.getLogo.mockResolvedValue(null);
    const res = await PUT(req("PUT", style));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_logo" });
    expect(logos.getLogo).toHaveBeenCalledWith(admin, "logo_1");

    logos.getLogo.mockResolvedValue({ ...logoRow, filename: "7c9e6679-7425-40de-944b-e07fc1f90ae7.png" });
    expect((await PUT(req("PUT", style))).status).toBe(400);
    logos.getLogo.mockResolvedValue({ ...logoRow, mimeType: "image/webp" });
    expect((await PUT(req("PUT", style))).status).toBe(400);
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("rounds and clamps the logo's measured size instead of refusing it", async () => {
    const res = await PUT(req("PUT", { ...style, logo: { ...style.logo, width: 199.6, height: 47.2 } }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[0]![1]).toMatchObject({ logo: { width: 200, height: 47 } });

    await PUT(req("PUT", { ...style, logo: { ...style.logo, width: 640, height: 0.2 } }));
    expect(control.setTenantEmailStyle.mock.calls[1]![1]).toMatchObject({ logo: { width: 200, height: 1 } });
  });

  it("saves for an admin: a cleaned name, lowercased colours, stamped with who saved it", async () => {
    const res = await PUT(req("PUT", { ...style, companyName: "  Example⁣ Co  ", headerColor: "#0B1F3A" }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith(
      "ten_A",
      { ...style, companyName: "Example Co", headerColor: "#0b1f3a" },
      undefined,
      { updatedBy: "usr_admin" },
    );
    expect(await res.json()).toMatchObject({ emailStyle: { companyName: "Example Co", headerColor: "#0b1f3a" } });
  });

  it("saving a reviewed suggestion asks for it to be cleared (if it's still the pending one)", async () => {
    const suggestedAt = "2026-09-27T10:00:00.000Z";
    const res = await PUT(req("PUT", { ...style, fromSuggestion: suggestedAt }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", style, undefined, {
      updatedBy: "usr_admin",
      clearSuggestionAt: suggestedAt,
    });
  });

  it("400s for a fromSuggestion that isn't a short string", async () => {
    for (const fromSuggestion of [42, "", "x".repeat(41)]) {
      expect((await PUT(req("PUT", { ...style, fromSuggestion }))).status).toBe(400);
    }
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("a blank name or no logo is fine", async () => {
    const res = await PUT(req("PUT", { ...style, logo: null, companyName: "   " }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[0]![1]).toMatchObject({ logo: null, companyName: null });
    expect(logos.getLogo).not.toHaveBeenCalled();
  });
});

describe("PUT header options (gradient, header text colour)", () => {
  const options = { headerGradientColor: "#4F46E5", headerText: "white" };
  // What the setter returns when it kept options already stored.
  const keptOptions = {
    ...style,
    headerGradientColor: "#4f46e5",
    headerText: "white",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };

  it("flag off: ignored even when sent — the setter keeps what's stored — and left out of the response", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    control.setTenantEmailStyle.mockResolvedValueOnce(keptOptions);
    const res = await PUT(req("PUT", { ...style, ...options }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", style, undefined, { updatedBy: "usr_admin" });
    const body = await res.json();
    expect(body.emailStyle).toEqual({ ...style, updatedAt: "2026-09-27T00:00:00.000Z" });

    // Off, even a value the flag-on parse would refuse is simply dropped.
    expect((await PUT(req("PUT", { ...style, headerGradientColor: "purple", headerText: "pink" }))).status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[1]![1]).toEqual(style);
  });

  it("flag on: passed through (colour 2 lowercased), and the response carries them", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    control.setTenantEmailStyle.mockResolvedValueOnce(keptOptions);
    const res = await PUT(req("PUT", { ...style, ...options }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith(
      "ten_A",
      { ...style, headerGradientColor: "#4f46e5", headerText: "white" },
      undefined,
      { updatedBy: "usr_admin" },
    );
    expect((await res.json()).emailStyle).toMatchObject({ headerGradientColor: "#4f46e5", headerText: "white" });

    await PUT(req("PUT", { ...style, headerGradientColor: null, headerText: "auto" }));
    expect(control.setTenantEmailStyle.mock.calls[1]![1]).toEqual({
      ...style,
      headerGradientColor: null,
      headerText: "auto",
    });
  });

  it.each([
    ["a colour 2 that isn't #rrggbb", { headerGradientColor: "purple" }],
    ["another text choice", { headerText: "pink" }],
  ])("flag on: 400s for %s", async (_label, over) => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const res = await PUT(req("PUT", { ...style, ...over }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });
});

describe("PUT header image", () => {
  const BANNER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg";
  const image = { id: "hdr_1", filename: BANNER, width: 1200, height: 300 };
  const headerRow = {
    id: "hdr_1",
    tenantId: "ten_A",
    category: "header",
    filename: BANNER,
    mimeType: "image/jpeg",
    title: "Spring banner",
    byteSize: 120000,
    width: 1200,
    height: 300,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  // What the setter returns when the style keeps (or takes) the image.
  const savedWithImage = { ...style, headerImage: image, updatedAt: "2026-09-27T00:00:00.000Z" };
  beforeEach(() => assets.getBrandAsset.mockResolvedValue(headerRow));

  it("flag off: ignored even when sent — the setter keeps what's stored — and left out of the response", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
    const res = await PUT(req("PUT", { ...style, headerImage: image }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", style, undefined, { updatedBy: "usr_admin" });
    expect((await res.json()).emailStyle).toEqual({ ...style, updatedAt: "2026-09-27T00:00:00.000Z" });

    // Off, even a value the flag-on parse would refuse is simply dropped.
    expect((await PUT(req("PUT", { ...style, headerImage: { ...image, filename: "x.webp" } }))).status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[1]![1]).toEqual(style);
    expect(assets.getBrandAsset).not.toHaveBeenCalled();
  });

  it("flag on: this tenant's header image is saved with the row's size, whatever the body says", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
    const res = await PUT(req("PUT", { ...style, headerImage: { ...image, width: 600.4, height: 99999 } }));
    expect(res.status).toBe(200);
    expect(assets.getBrandAsset).toHaveBeenCalledWith(admin, "hdr_1");
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", { ...style, headerImage: image }, undefined, {
      updatedBy: "usr_admin",
    });
    expect((await res.json()).emailStyle).toMatchObject({ headerImage: image });
    // Checked again after the write, and still there, so nothing is cleared.
    expect(assets.getBrandAsset).toHaveBeenCalledTimes(2);
    expect(control.clearTenantEmailStyleHeaderImage).not.toHaveBeenCalled();
  });

  it("flag on: an image deleted between the check and the write is taken back out, and left out of the response", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    // The Delete's first clear found nothing (the Save hadn't written yet), then it removed the row.
    assets.getBrandAsset.mockResolvedValueOnce(headerRow).mockResolvedValueOnce(null);
    control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
    const res = await PUT(req("PUT", { ...style, headerImage: image }));
    expect(res.status).toBe(200);
    expect(control.clearTenantEmailStyleHeaderImage).toHaveBeenCalledWith("ten_A", BANNER);
    const order = [
      assets.getBrandAsset.mock.invocationCallOrder[0]!,
      control.setTenantEmailStyle.mock.invocationCallOrder[0]!,
      assets.getBrandAsset.mock.invocationCallOrder[1]!,
      control.clearTenantEmailStyleHeaderImage.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect((await res.json()).emailStyle).toEqual({ ...style, updatedAt: "2026-09-27T00:00:00.000Z" });
  });

  it("flag on: a look after the write that fails still answers the Save as saved", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The read after the write fails: the Save went through, so it's answered as saved.
      assets.getBrandAsset.mockResolvedValueOnce(headerRow).mockRejectedValueOnce(new Error("unavailable"));
      control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
      const res = await PUT(req("PUT", { ...style, headerImage: image }));
      expect(res.status).toBe(200);
      expect((await res.json()).emailStyle).toEqual(savedWithImage);
      expect(control.clearTenantEmailStyleHeaderImage).not.toHaveBeenCalled();

      // The row is gone but the clear fails: still saved, and still as stored (with the image).
      assets.getBrandAsset.mockResolvedValueOnce(headerRow).mockResolvedValueOnce(null);
      control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
      control.clearTenantEmailStyleHeaderImage.mockRejectedValueOnce(new Error("contention"));
      const again = await PUT(req("PUT", { ...style, headerImage: image }));
      expect(again.status).toBe(200);
      expect((await again.json()).emailStyle).toEqual(savedWithImage);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("flag on: a Save that leaves the image out or picks Colour doesn't look again", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    control.setTenantEmailStyle.mockResolvedValueOnce(savedWithImage);
    expect((await PUT(req("PUT", style))).status).toBe(200);
    expect((await PUT(req("PUT", { ...style, headerImage: null }))).status).toBe(200);
    expect(assets.getBrandAsset).not.toHaveBeenCalled();
    expect(control.clearTenantEmailStyleHeaderImage).not.toHaveBeenCalled();
  });

  it("flag on: null (the colour header) passes without a lookup", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const res = await PUT(req("PUT", { ...style, headerImage: null }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[0]![1]).toEqual({ ...style, headerImage: null });
    expect(assets.getBrandAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["another tenant's (or no) row", null],
    ["an icon row", { ...headerRow, category: "icon" }],
    ["a WebP row", { ...headerRow, mimeType: "image/webp" }],
    ["a row with no size", { ...headerRow, width: undefined, height: undefined }],
    ["a filename mismatch", { ...headerRow, filename: "7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg" }],
  ])("flag on: 400 invalid_header_image for %s", async (_label, row) => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    assets.getBrandAsset.mockResolvedValue(row);
    const res = await PUT(req("PUT", { ...style, headerImage: image }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_header_image", message: "Pick one of your header images." });
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("flag on: 400 invalid_input for an image that isn't a reference to a PNG/JPEG", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    for (const headerImage of [{ ...image, filename: "x.webp" }, "https://app.example.com/banner.jpg", { ...image, id: "a/b" }]) {
      const res = await PUT(req("PUT", { ...style, headerImage }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/brand-kit/email-style", () => {
  it("clears the style for an admin", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", null);
  });
});
