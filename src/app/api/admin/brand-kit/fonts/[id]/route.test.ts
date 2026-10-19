import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ deleteBrandFontBytes: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/brandFontStore", () => store);
const rows = vi.hoisted(() => ({ getBrandFont: vi.fn(), updateBrandFont: vi.fn(), deleteBrandFont: vi.fn(async () => {}) }));
vi.mock("@/lib/admin/brandFonts", () => rows);

const { DELETE } = await import("./route");
const del = () => DELETE(new Request("http://localhost/api/admin/brand-kit/fonts/f1", { method: "DELETE" }), { params: Promise.resolve({ id: "f1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_FONTS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
});

describe("DELETE font", () => {
  it("deletes the upload and its TTF copy", async () => {
    rows.getBrandFont.mockResolvedValueOnce({ id: "f1", filename: "abc.woff2", derivedFilename: "abc.ttf" });
    expect((await del()).status).toBe(200);
    expect(store.deleteBrandFontBytes.mock.calls).toEqual([["ten_A", "abc.woff2"], ["ten_A", "abc.ttf"]]);
  });

  it("a font with no copy deletes just the upload", async () => {
    rows.getBrandFont.mockResolvedValueOnce({ id: "f1", filename: "abc.ttf" });
    await del();
    expect(store.deleteBrandFontBytes.mock.calls).toEqual([["ten_A", "abc.ttf"]]);
  });
});
