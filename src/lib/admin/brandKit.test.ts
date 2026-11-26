import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { LoopStamp } from "@/lib/types/loopStamp";

// recordImageAsset takes the id minted before learnedFor ran, and its stamp (learning loops step 4).
const store = vi.hoisted(() => ({ db: null as unknown as FakeFirestore }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { newImageAssetId, recordImageAsset } = await import("./brandKit");

const hearth = { tenantId: "ten_hearth", region: "us" } as const;
const stamp: LoopStamp = {
  made: "m1.image_style.natural_photo.1.l",
  kind: "post_image",
  scope: "image_style.natural_photo",
  v: 1,
  arm: "learned",
  items: ["look1"],
  prompt: null,
  tokens: { rules: 24, examples: 0 },
  at: "2027-01-15T10:00:00.000Z",
};
const input = { workspaceId: "ws_hearth", filename: "loaf.png", mimeType: "image/png", kind: "social" as const, style: "natural_photo" };

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

beforeEach(() => {
  store.db = new FakeFirestore();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("recordImageAsset", () => {
  it("stores the image under the id it was given, so the holdback's hash and the row name the same image", async () => {
    const id = newImageAssetId();
    const row = await recordImageAsset(hearth, { ...input, id });
    expect(row.id).toBe(id);
    expect(store.db.raw("image_assets", id)).toMatchObject({ tenantId: "ten_hearth", filename: "loaf.png" });
  });

  it("mints an id when given none, as before", async () => {
    const row = await recordImageAsset(hearth, input);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an id a row already has, or one that isn't a document id", async () => {
    const id = newImageAssetId();
    await recordImageAsset(hearth, { ...input, id });
    await expect(recordImageAsset(hearth, { ...input, id })).rejects.toThrow();
    await expect(recordImageAsset(hearth, { ...input, id: "a/b" })).rejects.toThrow(/letters, digits/);
  });

  it("keeps its stamp with image style versions on", async () => {
    versionsOn();
    const own = await recordImageAsset(hearth, { ...input, id: "img-stamped", made: stamp });
    expect(own.made).toEqual(stamp);
    expect(store.db.raw("image_assets", "img-stamped")).toMatchObject({ made: stamp });
    await recordImageAsset(hearth, { ...input, kind: "upload", id: "img-upload", made: { unstamped: "own_image" } });
    expect(store.db.raw("image_assets", "img-upload")).toMatchObject({ made: { unstamped: "own_image" } });
  });

  it("keeps the row exactly as before with them off (decision 22)", async () => {
    const row = await recordImageAsset(hearth, { ...input, id: "img-off", made: { unstamped: "image_versions_off" } });
    expect(row).not.toHaveProperty("made");
    expect(store.db.raw("image_assets", "img-off")).not.toHaveProperty("made");
  });
});
