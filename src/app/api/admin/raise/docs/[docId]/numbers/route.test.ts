import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Refresh numbers: admins only; YouGrow's numbers filled again, and a version only when one moved.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));

const { POST } = await import("./route");
const { createRaiseDoc, readRaiseDoc } = await import("@/lib/raise/docs/store");
const { block, preSeedSlides } = await import("@/lib/raise/docs/testing/fixtures");

const admin = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as const;
const req = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const at = (docId: string) => ({ params: Promise.resolve({ docId }) });

let db: FakeFirestore;
let id: string;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  const slides = preSeedSlides();
  // Stored as 0 sign-ups, as of an earlier day.
  slides[3] = { ...slides[3]!, blocks: [block({ value: 1, display: "1", asOf: "2026-11-01T00:00:00.000Z" })] };
  const made = await createRaiseDoc(admin, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides, sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db });
  if (!made.ok) throw new Error(made.error);
  id = made.value.id;
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/raise/docs/[docId]/numbers", () => {
  it("is for admins, and 400s without the version it was made from", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await POST(req({ baseVersion: 1 }), at(id))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await POST(req({}), at(id))).status).toBe(400);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req({ baseVersion: 1 }), at(id))).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_acme", { prefix: "raise_numbers", burstLimit: 4, hourlyLimit: 30 }, expect.anything());
  });

  it("saves a version when a figure moved, with a note saying which, and none when nothing did", async () => {
    for (let i = 0; i < 3; i += 1) db.seed("signups", `s${i}`, { tenantId: "ten_acme", campaignId: "camp_spring", status: "verified_active", createdAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString() });
    const moved = await POST(req({ baseVersion: 1 }), at(id));
    expect(moved.status).toBe(200);
    const body = await moved.json();
    expect(body.changed).toEqual([{ slideN: 4, name: "sign-ups", from: "1", to: "3" }]);
    expect(body.doc.versions[0]).toMatchObject({ n: 2, note: "Numbers refreshed: slide 4 sign-ups 1 to 3." });
    const still = await POST(req({ baseVersion: 2 }), at(id));
    expect((await still.json()).changed).toEqual([]);
    expect((await readRaiseDoc(admin, id, { db }))!.version).toBe(2);
    const stale = await POST(req({ baseVersion: 1 }), at(id));
    expect(stale.status).toBe(409);
  });
});
