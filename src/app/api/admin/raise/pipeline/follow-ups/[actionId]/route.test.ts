import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Deciding a follow-up (RAISE_FOLLOWUPS_ENABLED): admins only, this brand's follow-ups only.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { POST } = await import("./route");
const { boardWorld } = await import("@/lib/raise/pipeline/testing/world");
const { followUpProposal } = await import("@/lib/raise/pipeline/followups");
const { proposeAgentAction } = await import("@/lib/tenant");

const admin = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const post = (actionId: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/admin/raise/pipeline/follow-ups/${actionId}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ actionId }),
  });

let db: FakeFirestore;
let actionId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED", "RAISE_FOLLOWUPS_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
  const w = await boardWorld(db, { ctx: admin });
  const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
  const r = await proposeAgentAction(
    admin,
    followUpProposal({ personId: sam, due: "quiet", day: "2026-11-01", stageOptionId: w.stage("contacted"), stageField: w.ids.stage, dateField: w.ids.lastTouch, at: new Date().toISOString() }),
    { db },
  );
  actionId = r.action.id;
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/raise/pipeline/follow-ups/[actionId]", () => {
  it("doesn't exist with follow-ups off, even with the board on", async () => {
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "false");
    expect((await post(actionId, { op: "dismiss", rev: 1 })).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("blocks another site, needs a session and an admin, and refuses bad input", async () => {
    expect((await post(actionId, { op: "dismiss", rev: 1 }, { origin: "https://elsewhere.test" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await post(actionId, { op: "dismiss", rev: 1 })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await post(actionId, { op: "dismiss", rev: 1 })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await post(actionId, { op: "dismiss" })).status).toBe(400);
    expect((await post(actionId, { op: "dismiss", rev: 1, tenantId: "ten_b" })).status).toBe(400);
    expect(db.raw("agent_actions", actionId)!.state).toBe("proposed");
  });

  it("follows up, then answers stale for the same row again", async () => {
    const res = await post(actionId, { op: "followed_up", rev: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.raw("agent_actions", actionId)!.state).toBe("acted");
    expect((await post(actionId, { op: "dismiss", rev: 1 })).status).toBe(409);
  });

  it("reads another brand's follow-up as not found", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_b" });
    expect((await post(actionId, { op: "dismiss", rev: 1 })).status).toBe(404);
    expect((await post("aa_notanid", { op: "dismiss", rev: 1 })).status).toBe(404);
    expect(db.raw("agent_actions", actionId)!.state).toBe("proposed");
  });
});
