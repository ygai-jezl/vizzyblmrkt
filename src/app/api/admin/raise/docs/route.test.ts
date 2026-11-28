import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Content › Raise kit: the switch, then sign-in, then the role, then input; New deck also asks the
// plan, the draft limit and the 20 deck limit before Vizzy drafts.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const model = vi.hoisted(() => ({ generateJsonWithSchema: vi.fn(async () => null as string | null) }));
vi.mock("@/lib/agents/gemini", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agents/gemini")>()), generateJsonWithSchema: model.generateJsonWithSchema }));

const { GET, POST } = await import("./route");

const admin = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/raise/docs", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  vi.stubEnv("PLANS_ENABLED", "");
  session.getAdminContext.mockResolvedValue(admin);
  db.seed("tenants", "ten_acme", { tenantName: "Acme", rootDomain: "acme.example", ownerId: "usr_admin", status: "active", region: "us", allowedOrigins: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/raise/docs", () => {
  it("503s with the switch off, before anything else", async () => {
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    for (const res of [await GET(req("GET")), await POST(req("POST", { audience: "investor" }))]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "raise_kit_disabled" });
    }
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out, lets a member list but not make, and 400s bad input", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await POST(req("POST", { audience: "investor" }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const list = await GET(req("GET"));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ docs: [], granted: true, canMake: false, limit: 20 });
    expect((await POST(req("POST", { audience: "investor" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    for (const body of [{ audience: "bank" }, { audience: "lender", brief: "x".repeat(1501) }, { audience: "investor", stage: "series_a" }, null]) {
      const res = await POST(req("POST", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
    expect(model.generateJsonWithSchema).not.toHaveBeenCalled();
  });

  it("403s a brand without the Raise kit, 429s when rate limited and 409s at 20 decks", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "raise_kit");
    const out = await POST(req("POST", { audience: "investor" }));
    expect(out.status).toBe(403);
    expect(await out.json()).toEqual({ error: "not_included" });
    expect(await (await GET(req("GET"))).json()).toMatchObject({ granted: false, canMake: false });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req("POST", { audience: "investor" }))).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_acme", { prefix: "raise_draft", burstLimit: 2, hourlyLimit: 8 }, expect.anything());
    for (let i = 0; i < 20; i += 1) db.seed("raise_docs", `rd_seed${String(i).padStart(8, "0")}`, { tenantId: "ten_acme" });
    const full = await POST(req("POST", { audience: "investor" }));
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "deck_limit" });
    expect(model.generateJsonWithSchema).not.toHaveBeenCalled();
  });

  it("saves the outline when the model can't write, then lists it", async () => {
    const res = await POST(req("POST", { audience: "investor", brief: "For a spring round" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ drafted: false, doc: { kindLabel: "Investor deck, pre-seed", version: 1, canEdit: true } });
    expect(body.doc.slides).toHaveLength(10);
    expect(model.generateJsonWithSchema).toHaveBeenCalledTimes(1);
    const list = await (await GET(req("GET"))).json();
    expect(list.docs).toEqual([expect.objectContaining({ id: body.doc.id, title: "Acme", slideCount: 10, version: 1, status: "draft" })]);
    expect(list.canMake).toBe(true);
  });

  it("drafts a 5 slide lender pack from the model's answer", async () => {
    const sections = ["cover", "sales", "use_of_funds", "repayment", "team"];
    model.generateJsonWithSchema.mockResolvedValueOnce(
      JSON.stringify({ title: "Fernhill Plants stock loan", slides: sections.map((section) => ({ section, layout: "statement", headline: `Fernhill Plants ${section.replace(/_/g, " ")} at a glance`, points: [], notes: "We sell plants." })) }),
    );
    const res = await POST(req("POST", { audience: "lender" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ drafted: true, doc: { audience: "lender", stage: "loan", kindLabel: "Lender pack", title: "Fernhill Plants stock loan" } });
    expect(body.doc.slides.map((s: { section: string }) => s.section)).toEqual(sections);
  });
});
