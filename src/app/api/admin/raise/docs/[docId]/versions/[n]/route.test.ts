import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// A kept version, to view (any member), and putting it back as a new version (admins).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));

const { GET } = await import("./route");
const { POST } = await import("./restore/route");
const { createRaiseDoc, saveRaiseVersion } = await import("@/lib/raise/docs/store");
const { preSeedSlides } = await import("@/lib/raise/docs/testing/fixtures");

const admin = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as const;
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown) => new Request("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (docId: string, n: string) => ({ params: Promise.resolve({ docId, n }) });

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
  await saveRaiseVersion(admin, id, { baseVersion: 1, slides: made.value.current.slides.slice(0, 6), by: "usr_admin" }, { db });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/raise/docs/[docId]/versions/[n]", () => {
  it("shows a kept version with its checks to any member, and 404s one that isn't kept", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await GET(req("GET"), at(id, "2"));
    expect(res.status).toBe(200);
    const { version } = await res.json();
    expect(version).toMatchObject({ n: 2, by: "A teammate", note: "Removed slides 7, 8, 9 and 10." });
    expect(version.checks.map((c: { code: string }) => c.code)).toEqual(["missing_ask", "missing_section"]);
    for (const n of ["9", "0", "x"]) {
      const missing = await GET(req("GET"), at(id, n));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "version_not_kept" });
    }
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_fernhill" });
    expect(await (await GET(req("GET"), at(id, "1"))).json()).toEqual({ error: "not_found" });
  });

  it("puts a version back as a new one, for admins, from the version they read", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await POST(req("POST", { baseVersion: 2 }), at(id, "1"))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await POST(req("POST", {}), at(id, "1"))).status).toBe(400);
    const back = await POST(req("POST", { baseVersion: 2 }), at(id, "1"));
    expect(back.status).toBe(200);
    expect((await back.json()).doc).toMatchObject({ version: 3, versions: [{ n: 3, note: "Put back version 1." }, { n: 2 }, { n: 1 }] });
    expect((await POST(req("POST", { baseVersion: 2 }), at(id, "1"))).status).toBe(409);
    expect((await POST(req("POST", { baseVersion: 3 }), at(id, "7"))).status).toBe(404);
  });
});
