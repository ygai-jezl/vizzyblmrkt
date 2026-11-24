import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, type TenantContext } from "@/lib/tenant";
import { seedSearchConsole, seedSuggestion } from "@/lib/connectors/testing/signals";

// Plan an article and Dismiss on a suggestion from collected numbers: origin, switch, sign in,
// the admin role, then the id and the body; the brand is the session's. Made-up sites and numbers.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const approve = await import("./[signalId]/approve/route");
const dismiss = await import("./[signalId]/dismiss/route");

const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...A, userId: "usr_member", role: "member" };
const otherBrand = { ...A, tenantId: "ten_b" };
const ID = "dcn_ssssssssssssssssssss";

let db: FakeFirestore;
let signalId: string;
const req = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/admin/data-signals/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ signalId: id }) });
const plan = (id = signalId, body: unknown = {}, headers: Record<string, string> = {}) => approve.POST(req(`${id}/approve`, body, headers), p(id));
const drop = (id = signalId, headers: Record<string, string> = {}) => dismiss.POST(req(`${id}/dismiss`, {}, headers), p(id));

beforeEach(async () => {
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
  session.getAdminContext.mockReset();
  session.getAdminContext.mockResolvedValue(A);
  await seedSearchConsole(A, db, ID);
  await forTenant(A, db).workspaces.create("ws_blog", { name: "Plant care blog", createdAt: "2026-11-01T00:00:00.000Z" } as never);
  signalId = (await seedSuggestion(A, db, ID, "losing")).signalId;
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/data-signals/<id>/approve and /dismiss", () => {
  it("answer 404 with signals off, before reading the session", async () => {
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    expect((await plan()).status).toBe(404);
    expect((await drop()).status).toBe(404);
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect((await plan()).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuse a cross-site request, the signed out and a member", async () => {
    expect((await plan(signalId, {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await drop(signalId, { origin: "https://evil.example" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await plan()).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await plan()).status).toBe(403);
    expect((await drop()).status).toBe(403);
  });

  it("400 a bad id or body, and 404 another brand's suggestion", async () => {
    expect((await plan("dsg_123")).status).toBe(400);
    expect((await drop("sig_" + "0".repeat(24))).status).toBe(400);
    expect((await plan(signalId, { workspaceId: "ws blog" })).status).toBe(400);
    expect((await plan(signalId, { tenantId: "ten_b" })).status).toBe(400);
    expect((await plan(signalId, "not json")).status).toBe(400);
    session.getAdminContext.mockResolvedValue(otherBrand);
    expect((await plan()).status).toBe(404);
    expect((await drop()).status).toBe(404);
  });

  it("plan an article: the Create link back, and the suggestion closed", async () => {
    const res = await plan();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, href: "/admin/workspace/ws_blog/create?numbers=page&text=%2Fcare%2Ffiddle-leaf-fig&hub=https%3A%2F%2Ffernhill.example%2Fcare%2Ffiddle-leaf-fig" });
    const again = await plan();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "changed" });
  });

  it("dismiss: closed, kept away 30 days", async () => {
    const res = await drop();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dismissedUntil: expect.any(String) });
    expect((await drop()).status).toBe(409);
  });
});
