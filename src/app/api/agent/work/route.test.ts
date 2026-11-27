import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorld, PEOPLE, type World } from "@/lib/work/testing/world";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "@/lib/work/testing/fixtures";

// Vizzy's Work route (WORK_VIZZY_ENABLED, which needs WORK_ENABLED): the switch, the canvas token,
// the brand's rate limit, then the tool. The brand and the person come from the token only. Made-up
// Lumen [Lumen Notes in the United States, Lumen Europe]; one fake database per Firestore
// database, with (default) both the control plane and the United States data, as in production.
// A person then saves Vizzy's drafts through Work's admin routes, which mock @/lib/auth/session.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), ...limits }));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => ({ getUsers: async () => ({ users: [] }) }) }));
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const { GET, POST } = await import("./route");
const logRoute = await import("@/app/api/admin/work/log/route");
const decisionsRoute = await import("@/app/api/admin/work/decisions/route");
const tasksRoute = await import("@/app/api/admin/work/tasks/route");

const NINA_TOKEN = { tenantId: LUMEN_US, region: "us", source: "agent", userId: NINA, role: "admin" };
const HOST = "app.lumen.test";
const ORIGIN = `https://${HOST}`;
let w: World;

const agentGet = (query = "") => new Request(`${ORIGIN}/api/agent/work${query}`, { headers: { "x-canvas-context": "tok" } });
const agentPost = (body: unknown) => new Request(`${ORIGIN}/api/agent/work`, { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const admin = (path: string, method: string, body?: unknown) =>
  new Request(`${ORIGIN}/api/admin/work${path}`, { method, headers: { "content-type": "application/json", host: HOST, origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("WORK_ENABLED", "true");
  vi.stubEnv("WORK_VIZZY_ENABLED", "true");
  w = makeWorld();
  dbs.map = { "(default)": w.control, "signups-eu": w.eu, "signups-asia": w.asia };
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(NINA_TOKEN);
  session.getAdminContext.mockResolvedValue(PEOPLE.nina);
  await tasksRoute.POST(admin("/tasks", "POST", { title: "Pick a pottery supplier", brandId: LUMEN_US }));
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/work, the gate", () => {
  it("is unavailable with either switch off, before the token is read", async () => {
    for (const [work, vizzy] of [
      ["true", ""],
      ["", "true"],
      ["false", "false"],
    ]) {
      vi.stubEnv("WORK_ENABLED", work!);
      vi.stubEnv("WORK_VIZZY_ENABLED", vizzy!);
      for (const r of [await GET(agentGet()), await POST(agentPost({ tool: "suggest_work_task", title: "A" }))]) {
        expect(r.status).toBe(503);
        expect(await json(r)).toEqual({ error: "unavailable" });
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
  });

  it("401s a bad token and 429s past the brand's limit", async () => {
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(agentGet())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(agentPost({ tool: "draft_work_log", workstream: "A" }))).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith(`tenant:${LUMEN_US}`, expect.objectContaining({ prefix: "work_agent_write" }));
  });

  it("reads the token's brand and person only: a brand or tenant in the query or body is never used", async () => {
    auth.tenantContextFromCanvasToken.mockReturnValue({ ...NINA_TOKEN, userId: SAM, role: "member" });
    await tasksRoute.POST(admin("/tasks", "POST", { title: "Cookie notice in German", brandId: LUMEN_EU }));
    const r = await GET(agentGet(`?tenantId=${LUMEN_EU}&organisationId=org_ten_fernhill&userId=${NINA}`));
    expect(r.status).toBe(200);
    expect((await json(r)).tasks.map((t: { title: string }) => t.title)).toEqual(["Pick a pottery supplier"]);
    const sneaky = await POST(agentPost({ tool: "suggest_work_task", title: "Translate the site", tenantId: LUMEN_EU }));
    expect(sneaky.status).toBe(400);
    expect(await json(sneaky)).toMatchObject({ error: "invalid_input" });
    expect(w.eu.dump("agent_actions")).toEqual([]);
    expect(w.control.dump("agent_actions")).toEqual([]);
  });

  it("refuses a body over its cap, and one that isn't JSON", async () => {
    expect((await POST(agentPost({ tool: "suggest_work_task", title: "A", description: "x".repeat(70_000) }))).status).toBe(413);
    expect((await POST(agentPost("not json"))).status).toBe(400);
  });
});

describe("no one drafts a plan approval", () => {
  it("refuses draft_work_decision for Approve the plan, and writes nothing", async () => {
    const r = await POST(agentPost({ tool: "draft_work_decision", task: 1, question: "Approve the plan", options: ["Approve", "Change it", "Not now"], recommended: "a", reason: "It reads well." }));
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ error: "plan_drafted", message: expect.stringContaining("approving a plan stays with people") });
    expect(w.control.dump("agent_actions")).toEqual([]);
  });

  it("refuses a drafted decision saved as a plan approval, so Vizzy's pick never sits on one", async () => {
    const drafted = await json(await POST(agentPost({ tool: "draft_work_decision", task: 1, question: "Which supplier first?", options: ["Clay and Co", "Fernhill Pots"], recommended: "b", reason: "They deliver weekly." })));
    const id = drafted.card.id as string;
    const asPlan = await decisionsRoute.POST(admin("/decisions", "POST", { ref: 1, chosen: "a", plan: { url: "https://plans.lumen.example/p" }, draft: { id, rev: 1 } }));
    expect(asPlan.status).toBe(400);
    expect(await json(asPlan)).toMatchObject({ error: "invalid_input" });
    // Nor can a request carry a recommendation or the drafted question itself.
    for (const extra of [{ recommended: { option: "b" } }, { question: "Approve the plan", options: ["Approve", "Change it", "Not now"] }]) {
      expect((await decisionsRoute.POST(admin("/decisions", "POST", { ref: 1, chosen: "a", draft: { id, rev: 1 }, ...extra }))).status).toBe(400);
    }
    expect(w.control.dump("work_log").filter((r) => r.kind === "decision")).toEqual([]);
  });
});

describe("a person saves Vizzy's drafts", () => {
  it("saves a drafted note to today's log from the Log box, as the person changed it", async () => {
    const drafted = await json(await POST(agentPost({ tool: "draft_work_log", workstream: "Supplier calls", state: "doing", note: "Called two", task: "#1" })));
    expect(drafted.card.url).toBe(`/admin/work/log?draft=${drafted.card.id}`);
    const saved = await logRoute.POST(admin("/log", "POST", { workstream: "Supplier calls", state: "done", note: "Called both", ref: 1, draft: { id: drafted.card.id, rev: 1 } }));
    expect(saved.status).toBe(201);
    expect((await json(saved)).row).toMatchObject({ kind: "entry", state: "done", source: { tool: "draft_work_log", who: { kind: "person", id: NINA } } });
    expect(w.control.raw("agent_actions", drafted.card.id)).toMatchObject({ state: "acted", result: { edited: ["state", "note"] } });
    const again = await logRoute.POST(admin("/log", "POST", { workstream: "Supplier calls", state: "done", draft: { id: drafted.card.id, rev: 1 } }));
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: "draft_decided" });
  });

  it("chooses on a drafted decision, keeping Vizzy's pick beside the person's choice", async () => {
    const drafted = await json(await POST(agentPost({ tool: "draft_work_decision", task: "1", question: "Which supplier first?", options: ["Clay and Co", "Fernhill Pots"], recommended: "Fernhill Pots", reason: "They deliver weekly." })));
    expect(drafted.card.url).toBe(`/admin/work/1?decision=${drafted.card.id}#decisions`);
    session.getAdminContext.mockResolvedValue(PEOPLE.sam);
    const saved = await decisionsRoute.POST(admin("/decisions", "POST", { ref: 1, chosen: "a", why: "Nearer to us", draft: { id: drafted.card.id, rev: 1 } }));
    expect(saved.status).toBe(201);
    expect((await json(saved)).row.decision).toMatchObject({ recommended: { option: "b", by: { kind: "vizzy" }, reason: "They deliver weekly." }, chosen: { option: "a", by: SAM }, agreed: false, why: "Nearer to us" });
  });
});
