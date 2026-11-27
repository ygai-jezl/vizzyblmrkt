import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// A value set on a person's page clears their open follow-ups from the investor board (RAISE_FOLLOWUPS_ENABLED).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { patchFieldValues } = await import("./fieldValueRoute");
const { boardWorld } = await import("@/lib/raise/pipeline/testing/world");
const { followUpProposal } = await import("@/lib/raise/pipeline/followups");
const { proposeAgentAction } = await import("@/lib/tenant");

const admin = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const patch = (id: string, changes: unknown) => patchFieldValues(new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes }) }), "person", id);

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED", "RAISE_FOLLOWUPS_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

async function world() {
  const w = await boardWorld(db, { ctx: admin });
  const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
  const r = await proposeAgentAction(
    admin,
    followUpProposal({ personId: sam, due: "quiet", day: "2026-11-01", stageOptionId: w.stage("contacted"), stageField: w.ids.stage, dateField: w.ids.lastTouch, at: new Date().toISOString() }),
    { db },
  );
  return { w, sam, id: r.action.id };
}

describe("patchFieldValues and the board's follow-ups", () => {
  it("marks the quiet follow-up acted when Last touch changes on their page", async () => {
    const { w, sam, id } = await world();
    const res = await patch(sam, { [w.ids.lastTouch]: "2026-11-25" });
    expect(res.status).toBe(200);
    expect(db.raw("agent_actions", id)).toMatchObject({ state: "acted", actedBy: { type: "member", id: "u_admin" } });
  });

  it("reads no follow-ups with them off, and leaves a change to another field alone", async () => {
    const { w, sam, id } = await world();
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "false");
    const before = db.collectionCalls("agent_actions");
    expect((await patch(sam, { [w.ids.lastTouch]: "2026-11-25" })).status).toBe(200);
    expect(db.collectionCalls("agent_actions")).toBe(before);
    expect(db.raw("agent_actions", id)!.state).toBe("proposed");
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    await patch(sam, { [w.ids.firm]: "Fern Capital" });
    expect(db.raw("agent_actions", id)!.state).toBe("proposed");
  });
});
