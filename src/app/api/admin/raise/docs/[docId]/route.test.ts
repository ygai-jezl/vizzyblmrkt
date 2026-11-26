import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// One deck: any member reads it, admins save a version from the one they read and delete it.
// Another brand's deck id is simply not found.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));

const { GET, PUT, DELETE } = await import("./route");
const { createRaiseDoc } = await import("@/lib/raise/docs/store");
const { preSeedSlides } = await import("@/lib/raise/docs/testing/fixtures");

const admin = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as const;
const member = { ...admin, userId: "usr_member", role: "member" };
const other = { tenantId: "ten_fernhill", region: "us", source: "idtoken", userId: "usr_fern", role: "admin" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/raise/docs/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (docId: string) => ({ params: Promise.resolve({ docId }) });

let db: FakeFirestore;
let id: string;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  const made = await createRaiseDoc(admin, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides: preSeedSlides(), sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db });
  if (!made.ok) throw new Error(made.error);
  id = made.value.id;
});
afterEach(() => vi.unstubAllEnvs());

const slidesInput = async () => ((await (await GET(req("GET"), at(id))).json()).doc.slides as Array<Record<string, unknown>>).map(({ ai: _ai, ...s }) => s);

describe("/api/admin/raise/docs/[docId]", () => {
  it("503s off, 401s signed out, and lets a member read but not change", async () => {
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    for (const res of [await GET(req("GET"), at(id)), await PUT(req("PUT", {}), at(id)), await DELETE(req("DELETE"), at(id))]) expect(res.status).toBe(503);
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"), at(id))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const read = await GET(req("GET"), at(id));
    expect(read.status).toBe(200);
    expect((await read.json()).doc).toMatchObject({ id, canEdit: false, canDraft: false, version: 1 });
    expect((await PUT(req("PUT", { baseVersion: 1, slides: [] }), at(id))).status).toBe(403);
    expect((await DELETE(req("DELETE"), at(id))).status).toBe(403);
  });

  it("404s another brand's deck, or an id that isn't one", async () => {
    const slides = await slidesInput();
    session.getAdminContext.mockResolvedValue(other);
    for (const res of [await GET(req("GET"), at(id)), await PUT(req("PUT", { baseVersion: 1, slides }), at(id)), await DELETE(req("DELETE"), at(id))]) {
      expect(res.status).toBe(404);
    }
    session.getAdminContext.mockResolvedValue(admin);
    expect((await GET(req("GET"), at("../etc"))).status).toBe(404);
    expect(db.raw("raise_docs", id)).toBeDefined();
  });

  it("saves a change as version 2, refuses one from an older version, and 400s bad input", async () => {
    const slides = await slidesInput();
    slides[1] = { ...slides[1], headline: "Stock day takes a whole Sunday" };
    const ok = await PUT(req("PUT", { baseVersion: 1, slides, note: "Sharper problem" }), at(id));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ saved: true, doc: { version: 2, versions: [{ n: 2, note: "Sharper problem", by: "You" }, { n: 1, by: "Vizzy" }] } });
    const stale = await PUT(req("PUT", { baseVersion: 1, slides }), at(id));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_version", version: 2 });
    for (const bad of [{ baseVersion: 2, slides: slides.slice(0, 2) }, { baseVersion: 2, slides: [{ ...slides[0], layout: "poster" }, ...slides.slice(1)] }, { slides }]) {
      expect((await PUT(req("PUT", bad), at(id))).status).toBe(400);
    }
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_acme", { prefix: "raise_save", burstLimit: 20, hourlyLimit: 300 }, expect.anything());
  });

  it("429s when saving too often, and deletes the deck and every version", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await PUT(req("PUT", { baseVersion: 1, slides: await slidesInput() }), at(id))).status).toBe(429);
    const gone = await DELETE(req("DELETE"), at(id));
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ ok: true });
    expect(db.raw("raise_docs", id)).toBeUndefined();
    expect((await GET(req("GET"), at(id))).status).toBe(404);
  });
});
