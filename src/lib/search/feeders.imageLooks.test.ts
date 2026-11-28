import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Each image look in use is found in search as `learned`, ref image_style.<style>@<version>, the ref
 * Forget removes (learning loops step 4, 3.10); none while image style versions are off.
 */

const store = vi.hoisted(() => ({ db: null as unknown as FakeFirestore }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { imageLookSource, imageLookStubs } = await import("./feeders");
const { lookSearchRef } = await import("@/lib/loops/actions");
const { appendPatternVersionTx } = await import("@/lib/tenant/patternVersions");
const { runLoopsTransaction, writeBrandPointersTx } = await import("@/lib/tenant/loops");

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken", role: "admin", userId: "usr_maya" };
const NATURAL = "image_style.natural_photo";
const LOOK = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";

beforeEach(async () => {
  store.db = new FakeFirestore();
  await runLoopsTransaction(hearth, async (txn) => {
    for (const [v, text] of [
      [1, LOOK],
      [2, null],
    ] as const) {
      appendPatternVersionTx(txn, hearth, {
        channel: NATURAL,
        version: v,
        directive: null,
        perform: [],
        avoid: [],
        judgeRationale: "",
        evidence: [],
        createdBy: v === 1 ? "auto" : "forget",
        createdAt: "2027-01-14T09:00:00.000Z",
        loop: "image_style",
        setBy: "learned",
        items: text ? [{ id: "look1", type: "rule", text, trust: "own_content", from: "votes" }] : [],
        change: { op: "add", itemId: "look1" },
      });
    }
    writeBrandPointersTx(txn, hearth, { scopes: { [NATURAL]: { v: 1, setBy: "learned", adoptedAt: "2027-01-14T09:00:00.000Z" } } });
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("image looks in search", () => {
  it("names a look by its style and version, with the ref Forget removes", () => {
    const s = imageLookSource(NATURAL, 1, LOOK);
    expect(s).toMatchObject({ kind: "learned", ref: lookSearchRef(NATURAL, 1), title: "Natural photo image look, version 1", url: "/admin/brand-kit/image-style#learned" });
    expect(s.body).toContain(LOOK);
    expect(imageLookSource("image_style.brand", 2, "Warm light.").title).toBe("Your brand's image look, version 2");
  });

  it("lists each look in use while versions are on, and none while they are off", async () => {
    expect(await imageLookStubs(hearth)).toEqual([]);
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    const stubs = await imageLookStubs(hearth);
    expect(stubs.map((s) => s.ref)).toEqual([`${NATURAL}@1`]);
    expect((await stubs[0]!.load())?.body).toContain(LOOK);
  });
});
