import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbookDoc } from "@/lib/types/contentPlan";

// The eBook cover as a report cover (IMAGE_FORMATS_ENABLED): drawn at 4:5, no image model.
const BOOK: EbookDoc = { title: "The state of AI search", subtitle: "What 120 teams told us", industryLens: "", tocConfirmed: true, chapters: [] } as unknown as EbookDoc;
const guard = vi.hoisted(() => ({ guardEbookRoute: vi.fn() }));
vi.mock("@/lib/content/create/ebookRoute", () => guard);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme", imageStyle: { defaultStyleId: "data_story" } })) }));
vi.mock("@/lib/tenant", () => tenants);
const store = vi.hoisted(() => ({ draft: null as EbookDoc | null }));
const content = vi.hoisted(() => ({
  mutateContentPlanEbookDraft: vi.fn(async (_c: unknown, _w: string, _p: string, fn: (d: EbookDoc) => EbookDoc) => (store.draft = fn(store.draft!))),
}));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const creative = vi.hoisted(() => ({ generateEbookSlotImage: vi.fn(async () => ({ imageAssetRef: "painted.png", imagePrompt: "p" })) }));
vi.mock("@/lib/agents/creative", () => creative);
const render = vi.hoisted(() => ({ renderStyleImage: vi.fn(async (_r: Record<string, unknown>) => ({ png: Buffer.from("png"), width: 1080, height: 1350 }) as unknown) }));
vi.mock("@/lib/content/imageStyle/render/styleImage", () => render);
const assets = vi.hoisted(() => ({ storeWorkspaceImage: vi.fn(async () => ({ ok: true, filename: "cover.png" })), deleteWorkspaceAsset: vi.fn(async () => {}) }));
vi.mock("@/lib/workspace/assetStore", () => assets);
const kit = vi.hoisted(() => ({ recordImageAsset: vi.fn(async () => ({ id: "a1" })), deleteImageAsset: vi.fn(async () => {}) }));
vi.mock("@/lib/admin/brandKit", () => kit);

const { POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "p1" }) };
const req = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  store.draft = { ...BOOK };
  guard.guardEbookRoute.mockResolvedValue({ ok: { ctx: { tenantId: "ten_A", region: "us" }, ws: { id: "ws1" }, plan: { ebookDraft: store.draft } } });
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_FORMATS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST eBook cover as a report cover", () => {
  it("draws it from the eBook's title in the brand's style, at 4:5, with no image model", async () => {
    const res = await POST(req({ target: { kind: "cover" }, aspect: "4:5", format: "report_cover", formatInputs: { figure: { value: "120", unit: "teams" } } }), params);
    expect(res.status).toBe(200);
    expect(render.renderStyleImage.mock.calls[0]![0]).toMatchObject({
      template: "report_cover",
      size: "portrait",
      skin: "data_story",
      formatInputs: { title: "The state of AI search", subtitle: "What 120 teams told us", figure: { value: "120", unit: "teams" } },
    });
    expect(creative.generateEbookSlotImage).not.toHaveBeenCalled();
    expect(store.draft!.coverImage).toMatchObject({ imageAssetRef: "cover.png", aspect: "4:5", format: "report_cover" });
  });

  it("with the formats switch off, the cover is painted as before", async () => {
    vi.stubEnv("IMAGE_FORMATS_ENABLED", "false");
    await POST(req({ target: { kind: "cover" }, aspect: "1:1", brief: "A bold cover", format: "report_cover" }), params);
    expect(render.renderStyleImage).not.toHaveBeenCalled();
    expect(creative.generateEbookSlotImage).toHaveBeenCalled();
  });
});
