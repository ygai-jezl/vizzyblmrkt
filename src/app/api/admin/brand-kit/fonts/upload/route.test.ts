import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Font uploads: with the brand image style off, exactly as before. With it on, the file is read
// (real family, weight, italic) and a WOFF2 gets a TTF copy for the image renderer.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({
  storeBrandFont: vi.fn(async () => ({ ok: true, filename: "abc.woff2", mimeType: "font/woff2" })),
  storeDerivedBrandFont: vi.fn(async () => "abc.ttf"),
  deleteBrandFontBytes: vi.fn(async () => {}),
  MAX_FONT_BYTES: 5 * 1024 * 1024,
}));
vi.mock("@/lib/tenant/brandFontStore", () => store);
const rows = vi.hoisted(() => ({
  recordBrandFont: vi.fn(async (_s: unknown, input: Record<string, unknown>) => ({ id: "f1", ...input })),
  countBrandFontsUpTo: vi.fn(async () => 0),
  updateBrandFont: vi.fn(),
  MAX_FONTS_PER_TENANT: 30,
}));
vi.mock("@/lib/admin/brandFonts", () => rows);

const { POST } = await import("./route");

const woff2 = readFileSync(join(process.cwd(), "public/email-fonts/inter-700.v1.woff2"));
function req(): Request {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(woff2)], "Inter-Bold.woff2", { type: "font/woff2" }));
  return new Request("http://localhost/api/admin/brand-kit/fonts/upload", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_FONTS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST font upload", () => {
  it("switch off: named from the file name, nothing read, no copy", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(rows.recordBrandFont.mock.calls[0]![1]).toEqual({
      family: "Inter Bold",
      filename: "abc.woff2",
      mimeType: "font/woff2",
      title: "Inter-Bold.woff2",
      byteSize: woff2.length,
    });
    expect(store.storeDerivedBrandFont).not.toHaveBeenCalled();
  });

  it("switch on: the font's own family and weight, and a TTF copy", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req());
    expect(rows.recordBrandFont.mock.calls[0]![1]).toMatchObject({
      family: "Inter",
      weight: 700,
      italic: false,
      derivedFilename: "abc.ttf",
      inspectedAt: expect.any(String),
    });
  });

  it("switch on: if the row can't be saved, the copy is removed too", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    rows.recordBrandFont.mockRejectedValueOnce(new Error("down"));
    expect((await POST(req())).status).toBe(502);
    expect(store.deleteBrandFontBytes).toHaveBeenCalledWith("ten_A", "abc.ttf");
  });
});
