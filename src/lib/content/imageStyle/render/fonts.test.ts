import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrandFont } from "@/lib/types/brandFont";

const store = vi.hoisted(() => ({
  storeDerivedBrandFont: vi.fn(async (_t: string, source: string, _b: Buffer) => source.replace(/\.[^.]+$/, ".ttf")),
  readBrandFont: vi.fn(),
}));
vi.mock("@/lib/tenant/brandFontStore", () => store);
const rows = vi.hoisted(() => ({
  updateBrandFont: vi.fn(async (_c: unknown, _id: string, patch: Record<string, unknown>) => ({ ...base, ...patch })),
}));
vi.mock("@/lib/admin/brandFonts", () => rows);

const { inspectUploadedFont, inspectedFields, ensureFontInspected } = await import("./fonts");
const { renderableFilename, fontWeightLabel } = await import("../fontRows");

const font = (name: string) => readFileSync(join(process.cwd(), "public/email-fonts", name));
const ctx = { tenantId: "ten_A", region: "us" as const, source: "system" as const };
const base: BrandFont = {
  id: "f1",
  tenantId: "ten_A",
  family: "Inter Bold",
  filename: "abc.woff2",
  mimeType: "font/woff2",
  title: "Inter-Bold.woff2",
  byteSize: 10,
  createdAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("brand fonts for the renderer", () => {
  it("a WOFF2 upload gets a TTF copy beside it, and its weight", async () => {
    const r = await inspectUploadedFont("ten_A", { filename: "abc.woff2", mimeType: "font/woff2" }, font("inter-700.v1.woff2"));
    expect(r).toEqual({ info: { family: "Inter", weight: 700, italic: false }, derivedFilename: "abc.ttf" });
    const ttf = store.storeDerivedBrandFont.mock.calls[0]![2];
    expect(ttf.toString("latin1", 0, 4)).toBe("\u0000\u0001\u0000\u0000");
    expect(inspectedFields(r, "2026-10-19T00:00:00Z")).toEqual({
      weight: 700,
      italic: false,
      derivedFilename: "abc.ttf",
      inspectedAt: "2026-10-19T00:00:00Z",
    });
  });

  it("a WOFF is read as it is, with no copy", async () => {
    const r = await inspectUploadedFont("ten_A", { filename: "abc.woff", mimeType: "font/woff" }, font("lora-700.v1.woff"));
    expect(r).toEqual({ info: { family: "Lora", weight: 700, italic: false } });
    expect(store.storeDerivedBrandFont).not.toHaveBeenCalled();
  });

  it("an unreadable WOFF2 is kept, just not usable in images", async () => {
    const r = await inspectUploadedFont("ten_A", { filename: "abc.woff2", mimeType: "font/woff2" }, Buffer.from("wOF2 broken"));
    expect(r).toEqual({ info: null });
    expect(inspectedFields(r, "t")).toEqual({ inspectedAt: "t" });
    expect(renderableFilename({ ...base, inspectedAt: "t" })).toBeNull();
  });

  it("back-fills an older upload once", async () => {
    store.readBrandFont.mockResolvedValueOnce({ bytes: font("inter-700.v1.woff2"), contentType: "font/woff2" });
    const after = await ensureFontInspected(ctx, base);
    expect(after).toMatchObject({ weight: 700, derivedFilename: "abc.ttf" });
    expect(renderableFilename(after)).toBe("abc.ttf");
    expect(await ensureFontInspected(ctx, after)).toBe(after);
    expect(store.readBrandFont).toHaveBeenCalledTimes(1);
  });

  it("labels weights, and only uses files the renderer can read", () => {
    expect(fontWeightLabel({ weight: 700, italic: true })).toBe("Bold italic");
    expect(fontWeightLabel({ weight: 650 })).toBe("650");
    expect(fontWeightLabel({})).toBeNull();
    expect(renderableFilename(base)).toBeNull();
    expect(renderableFilename({ ...base, filename: "x.ttf", mimeType: "font/ttf" })).toBe("x.ttf");
    expect(renderableFilename({ ...base, filename: "x.ttf", mimeType: "font/ttf", inspectedAt: "t" })).toBeNull();
  });
});
