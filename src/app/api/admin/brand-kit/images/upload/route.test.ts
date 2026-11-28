import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A brand reference upload: with image style versions on (learning loops step 4, 3.4) it is a
// person's own image, stamped own_image, counted as a like and profiled; the old learner that
// rewrote the brand look on every upload runs only with versions off.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenants = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { find: vi.fn(async () => [{ id: "ws_hearth" }]) } })) }));
vi.mock("@/lib/tenant", () => tenants);
vi.mock("@/lib/workspace/assetStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/assetStore")>()),
  storeWorkspaceImage: vi.fn(async () => ({ ok: true, filename: "loaf.png" })),
}));
const kit = vi.hoisted(() => ({
  recordImageAsset: vi.fn(async (_scope: unknown, input: Record<string, unknown>) => ({ id: "img_up", tenantId: "ten_hearth", ...input })),
}));
vi.mock("@/lib/admin/brandKit", () => kit);
const profile = vi.hoisted(() => ({ refreshExemplarStyle: vi.fn(async () => undefined) }));
vi.mock("@/lib/content/create/styleProfile", () => profile);
const learner = vi.hoisted(() => ({ profileImage: vi.fn(async () => "profiled") }));
vi.mock("@/lib/loops/learners/votes", () => learner);
const rows = vi.hoisted(() => ({ countImageVote: vi.fn(async () => undefined) }));
vi.mock("@/lib/loops/imageRows", () => rows);
const control = vi.hoisted(() => ({ setTenantLearnedImageStyle: vi.fn(), setTenantStyleLearned: vi.fn() }));
vi.mock("@/lib/tenant/control", () => control);

const { POST } = await import("./route");

const upload = () => {
  const form = new FormData();
  form.set("file", new File([Buffer.from("png-bytes")], "loaf.png", { type: "image/png" }));
  return new Request("http://localhost/api/admin/brand-kit/images/upload", { method: "POST", body: form });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_hearth", region: "us", userId: "u_maya", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST brand reference upload", () => {
  it("with versions off, runs the old learner as before", async () => {
    const res = await POST(upload());
    expect(res.status).toBe(200);
    expect(kit.recordImageAsset).toHaveBeenCalledWith(
      { tenantId: "ten_hearth", region: "us" },
      expect.objectContaining({ kind: "upload", brandVote: "up", made: { unstamped: "own_image" } }),
    );
    expect(profile.refreshExemplarStyle).toHaveBeenCalledWith(expect.anything(), "img_up");
    expect(learner.profileImage).not.toHaveBeenCalled();
    expect(rows.countImageVote).not.toHaveBeenCalled();
  });

  it("with versions on, counts the upload as a like and profiles it, and nothing rewrites a look", async () => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    const res = await POST(upload());
    expect(res.status).toBe(200);
    expect(kit.recordImageAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ made: { unstamped: "own_image" }, brandVoteVia: "upload", firstVotedAt: expect.any(String) }),
    );
    expect(rows.countImageVote).toHaveBeenCalledWith(expect.anything(), { brandVote: null }, expect.objectContaining({ id: "img_up" }));
    expect(learner.profileImage).toHaveBeenCalledWith(expect.anything(), "img_up");
    expect(profile.refreshExemplarStyle).not.toHaveBeenCalled();
    expect(control.setTenantLearnedImageStyle).not.toHaveBeenCalled();
    expect(control.setTenantStyleLearned).not.toHaveBeenCalled();
  });

  it("a profile that fails never fails the upload", async () => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    learner.profileImage.mockRejectedValueOnce(new Error("model down"));
    expect((await POST(upload())).status).toBe(200);
  });
});
