import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenantMod = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws_1" })) } })),
  getTenantById: vi.fn(async () => null),
}));
vi.mock("@/lib/tenant", () => tenantMod);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(async () => ({ id: "p1" })) }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const hero = vi.hoisted(() => ({
  heroFromUpload: vi.fn(async (_i: unknown, _upload: { bytes: Buffer; mimeType: string }) => ({ ok: true, node: {}, hero: { status: "ready" } }) as unknown),
}));
vi.mock("@/lib/content/blog/hero", () => hero);

const { POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws_1", planId: "p1", nodeId: "hub" }) };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const up = (bytes: Buffer, type = "image/png") => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], "hero.png", { type }));
  return new Request("http://localhost/x", { method: "POST", body: fd });
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
  vi.stubEnv("BLOG_HERO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST blog hero upload", () => {
  it("takes a PNG (sniffed, not trusted from the browser)", async () => {
    expect((await POST(up(PNG, "image/webp"), params)).status).toBe(200);
    expect(hero.heroFromUpload.mock.calls[0]![1]).toMatchObject({ mimeType: "image/png" });
  });

  it("refuses what isn't PNG or JPEG", async () => {
    const res = await POST(up(Buffer.from("RIFF0000WEBPVP8 data"), "image/png"), params);
    expect(res.status).toBe(400);
    expect(hero.heroFromUpload).not.toHaveBeenCalled();
  });
});
