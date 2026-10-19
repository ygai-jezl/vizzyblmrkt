import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrandFont } from "@/lib/types/brandFont";
import type { Tenant } from "@/lib/types/tenant";

const font = (n: string) => readFileSync(join(process.cwd(), "public/email-fonts", n));
const LORA = font("lora-700.v1.woff");
const NUNITO = font("nunito-400.v1.woff");

const rows = vi.hoisted(() => ({ listBrandFonts: vi.fn(async () => [] as BrandFont[]), updateBrandFont: vi.fn() }));
vi.mock("@/lib/admin/brandFonts", () => rows);
const store = vi.hoisted(() => ({ readBrandFont: vi.fn(), storeDerivedBrandFont: vi.fn(), readCachedFont: vi.fn(), storeCachedFont: vi.fn() }));
vi.mock("@/lib/tenant/brandFontStore", () => store);
const google = vi.hoisted(() => ({ googleFontTtf: vi.fn(async (_f: string, _w: number) => null as Buffer | null) }));
vi.mock("./googleFonts", () => google);
const detect = vi.hoisted(() => ({ detectSiteFonts: vi.fn(async () => null), freeMatchFor: vi.fn(() => null) }));
vi.mock("@/lib/content/create/fontsFromWebsite", async (orig) => ({ ...(await orig<object>()), detectSiteFonts: detect.detectSiteFonts }));
const control = vi.hoisted(() => ({ setTenantSiteFonts: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/control", () => control);

const { fontsForRender } = await import("./renderFonts");

const ctx = { tenantId: "ten_A", region: "us" as const, source: "system" as const };
const upload = (over: Partial<BrandFont>): BrandFont => ({
  id: "f1",
  tenantId: "ten_A",
  family: "Lora",
  filename: "a.woff",
  mimeType: "font/woff",
  title: "Lora.woff",
  byteSize: 1,
  weight: 700,
  italic: false,
  inspectedAt: "t",
  createdAt: "t",
  ...over,
});
const tenant = (over: Partial<Tenant> = {}) => ({ id: "ten_A", tenantName: "Acme", rootDomain: "acme.com", ...over }) as Tenant;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("fontsForRender", () => {
  it("1. the brand's uploaded font comes first, for both roles when it's the only family", async () => {
    rows.listBrandFonts.mockResolvedValueOnce([upload({})]);
    store.readBrandFont.mockResolvedValue({ bytes: LORA, contentType: "font/woff" });
    const plan = await fontsForRender({ ctx, tenant: tenant(), text: "Hello world" });
    expect([plan.heading, plan.body]).toEqual(["Brand heading", "Brand body"]);
    expect(plan.fonts.find((f) => f.name === "Brand heading")).toMatchObject({ data: LORA, weight: 700 });
    expect(plan.bundledOnly).toBe(false);
    expect(google.googleFontTtf).not.toHaveBeenCalled();
  });

  it("an upload that can't draw the text is passed over", async () => {
    rows.listBrandFonts.mockResolvedValueOnce([upload({})]);
    store.readBrandFont.mockResolvedValue({ bytes: LORA, contentType: "font/woff" });
    const plan = await fontsForRender({ ctx, tenant: tenant(), text: "日本語" });
    expect(plan.heading).toBe("Bundled Inter");
  });

  it("2. with site fonts on, the family the site uses comes from Google Fonts", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED", "true");
    google.googleFontTtf.mockResolvedValue(NUNITO);
    const t = tenant({
      imageStyle: {
        defaultStyleId: null,
        siteFonts: { heading: { family: "Nunito", detected: "Nunito", source: "google" }, body: null, domain: "acme.com", detectedAt: "t" },
      },
    } as Partial<Tenant>);
    const plan = await fontsForRender({ ctx, tenant: t, text: "Hello" });
    expect(google.googleFontTtf.mock.calls.map((c) => c[0])).toEqual(["Nunito", "Nunito"]);
    expect([plan.heading, plan.body]).toEqual(["Brand heading", "Brand body"]);
    expect(detect.detectSiteFonts).not.toHaveBeenCalled();
  });

  it("with nothing saved, the site is read once and what it found is kept", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED", "true");
    await fontsForRender({ ctx, tenant: tenant({ id: "ten_B" } as Partial<Tenant>), text: "Hi" });
    await fontsForRender({ ctx, tenant: tenant({ id: "ten_B" } as Partial<Tenant>), text: "Hi" });
    expect(detect.detectSiteFonts).toHaveBeenCalledTimes(1);
    expect(detect.detectSiteFonts).toHaveBeenCalledWith("acme.com");
  });

  it("3. with site fonts off, nothing is fetched: the bundled fonts (Lora for a serif brand)", async () => {
    const t = tenant({ brandTypography: { styles: [{ id: "s", name: "Title", role: "title", fontFamily: "Playfair Display" }] } } as Partial<Tenant>);
    const plan = await fontsForRender({ ctx, tenant: t, text: "Hello" });
    expect(google.googleFontTtf).not.toHaveBeenCalled();
    expect([plan.heading, plan.body]).toEqual(["Bundled Lora", "Bundled Inter"]);
    expect(plan.bundledOnly).toBe(true);
    expect(plan.fonts.at(-1)!.name).toBe("Inter");
  });
});
