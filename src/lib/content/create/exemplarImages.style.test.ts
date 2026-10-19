import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kit = vi.hoisted(() => ({ listBrandExemplars: vi.fn() }));
vi.mock("@/lib/admin/brandKit", () => kit);
const store = vi.hoisted(() => ({
  readWorkspaceAsset: vi.fn(async (_t: string, _w: string, filename: string) => ({ bytes: Buffer.from(filename), contentType: "image/png" })),
}));
vi.mock("@/lib/workspace/assetStore", () => store);

const { retrieveExemplarImages } = await import("./exemplarImages");
const ctx = { tenantId: "ten_A", region: "us" } as never;
const row = (id: string, style: string | null) => ({ id, style, workspaceId: "ws", filename: `${id}.png`, kind: "social", channel: "linkedin", brandRating: 9 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_STYLE_REFS_ENABLED", "true");
  kit.listBrandExemplars.mockResolvedValue([row("a", "natural_photo"), row("b", "soft_3d"), row("c", "earthy"), row("d", null)]);
});
afterEach(() => vi.unstubAllEnvs());

const names = (refs: { base64: string }[]) => refs.map((r) => Buffer.from(r.base64, "base64").toString());

describe("retrieveExemplarImages by style", () => {
  it("absent: any style, as before", async () => {
    expect(names(await retrieveExemplarImages({ ctx }))).toEqual(["a.png", "b.png", "c.png"]);
    expect(kit.listBrandExemplars).toHaveBeenCalledWith(ctx, expect.objectContaining({ limit: 12 }));
  });

  it("a style: only that style's references, old presets included, from a wider pool", async () => {
    expect(names(await retrieveExemplarImages({ ctx, styleId: "natural_photo" }))).toEqual(["a.png", "c.png"]);
    expect(kit.listBrandExemplars).toHaveBeenCalledWith(ctx, expect.objectContaining({ limit: 40 }));
  });

  it("no references in that style: none at all", async () => {
    expect(await retrieveExemplarImages({ ctx, styleId: "paper_collage" })).toEqual([]);
  });
});
