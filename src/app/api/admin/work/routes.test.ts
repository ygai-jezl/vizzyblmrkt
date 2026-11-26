import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorld, PEOPLE, type World } from "@/lib/work/testing/world";
import { LUMEN_EU, LUMEN_US, ORG } from "@/lib/work/testing/fixtures";

// Work's admin routes (WORK_ENABLED): the origin check, the switch (404 while off, before the
// session is read), sign in, who the person is in Work, then the input. Lumen [made up] has Lumen
// Notes in the United States and Lumen Europe; one fake database per Firestore database, with
// (default) both the control plane and the United States data, as in production.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => ({ getUsers: async () => ({ users: [] }) }) }));
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const tasks = await import("./tasks/route");
const task = await import("./tasks/[ref]/route");
const logRoute = await import("./log/route");
const checks = await import("./checks/route");
const decisions = await import("./decisions/route");
const importRoute = await import("./import/route");

const HOST = "app.lumen.test";
const ORIGIN = `https://${HOST}`;

let w: World;
const as = (ctx: unknown) => session.getAdminContext.mockResolvedValue(ctx);

function req(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/admin/work${path}`, {
    method,
    headers: { "content-type": "application/json", host: HOST, origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (ref: string) => ({ params: Promise.resolve({ ref }) });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WORK_ENABLED", "true");
  w = makeWorld();
  // In production the United States regional database is (default), the control plane's.
  dbs.map = { "(default)": w.control, "signups-eu": w.eu, "signups-asia": w.asia };
  as(PEOPLE.nina);
});
afterEach(() => vi.unstubAllEnvs());

describe("with WORK_ENABLED off", () => {
  it("every Work route answers 404 before the session is read", async () => {
    vi.stubEnv("WORK_ENABLED", "");
    const answers = [
      await tasks.GET(req("/tasks")),
      await tasks.POST(req("/tasks", "POST", { title: "A" })),
      await task.GET(req("/tasks/1"), params("1")),
      await task.PATCH(req("/tasks/1", "PATCH", { title: "B" }), params("1")),
      await task.DELETE(req("/tasks/1", "DELETE"), params("1")),
      await logRoute.GET(req("/log")),
      await logRoute.POST(req("/log", "POST", { workstream: "A", state: "doing" })),
      await checks.POST(req("/checks", "POST", { ref: 1, action: "checked" })),
      await decisions.POST(req("/decisions", "POST", { ref: 1, question: "Q", options: ["A", "B"] })),
      await importRoute.POST(req("/import", "POST", { mode: "preview", text: "Task\nA" })),
    ];
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ error: "not_found" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });
});

describe("the gate", () => {
  it("refuses another site's request, then a signed out one, then a brand whose organisation doesn't list it", async () => {
    expect((await tasks.POST(req("/tasks", "POST", { title: "A" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await tasks.GET(req("/tasks", "GET", undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    as(null);
    expect((await tasks.GET(req("/tasks"))).status).toBe(401);
    as(PEOPLE.nina);
    w.control.seed("organisations", ORG, { ...w.control.raw("organisations", ORG)!, brandIds: [LUMEN_EU] });
    const r = await tasks.GET(req("/tasks"));
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ error: "no_organisation" });
  });
});

describe("tasks", () => {
  it("adds a task with the origin and region the server sets, and refuses one the request tries to set", async () => {
    const r = await tasks.POST(req("/tasks", "POST", { title: "Cookie notice in German", brandId: LUMEN_EU, stage: "set_up" }));
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(body.task.task).toMatchObject({ ref: 1, brandId: LUMEN_EU, region: "eu", origin: { kind: "person", by: PEOPLE.nina.userId } });
    expect(w.eu.raw("work_tasks", body.task.task.id)).toBeDefined();
    for (const extra of [{ origin: { kind: "import" } }, { organisationId: "org_ten_fernhill" }, { region: "us" }, { measure: { kind: "done", proposed: { kind: "done", reason: "x", by: "vizzy" } } }]) {
      const bad = await tasks.POST(req("/tasks", "POST", { title: "Sneaky", ...extra }));
      expect(bad.status, JSON.stringify(extra)).toBe(400);
      expect(await json(bad)).toMatchObject({ error: "invalid_input" });
    }
    expect((await tasks.POST(req("/tasks", "POST", "not json"))).status).toBe(400);
    expect((await tasks.POST(req("/tasks", "POST", { title: "x".repeat(130_000) }))).status).toBe(400);
  });

  it("lists every region's tasks for an owner, and a member's brand only, whatever the query names", async () => {
    await tasks.POST(req("/tasks", "POST", { title: "Pricing page", brandId: LUMEN_US }));
    await tasks.POST(req("/tasks", "POST", { title: "Cookie notice", brandId: LUMEN_EU }));
    const all = await json(await tasks.GET(req("/tasks")));
    expect(all.tasks.map((v: { task: { title: string } }) => v.task.title).sort()).toEqual(["Cookie notice", "Pricing page"]);
    expect(all.regionsDown).toEqual([]);
    as(PEOPLE.sam);
    const mine = await json(await tasks.GET(req(`/tasks?brand=${LUMEN_EU}&organisationId=org_ten_fernhill&tenantId=${LUMEN_EU}`)));
    expect(mine.tasks.map((v: { task: { title: string } }) => v.task.title)).toEqual(["Pricing page"]);
  });

  it("reads, changes and deletes one task by ref, answering 404 for a ref it can't see or read", async () => {
    await tasks.POST(req("/tasks", "POST", { title: "Cookie notice", brandId: LUMEN_EU }));
    expect((await json(await task.GET(req("/tasks/1"), params("1")))).task.title).toBe("Cookie notice");
    expect((await task.GET(req("/tasks/abc"), params("abc"))).status).toBe(404);
    expect((await task.GET(req("/tasks/0"), params("0"))).status).toBe(404);
    const changed = await task.PATCH(req("/tasks/1", "PATCH", { status: "in_progress" }), params("1"));
    expect(changed.status).toBe(200);
    expect((await json(changed)).task.task.status).toBe("in_progress");
    as(PEOPLE.sam);
    expect((await task.GET(req("/tasks/1"), params("1"))).status).toBe(404);
    expect((await task.PATCH(req("/tasks/1", "PATCH", { status: "done" }), params("1"))).status).toBe(404);
    await tasks.POST(req("/tasks", "POST", { title: "Sam's" }));
    const del = await task.DELETE(req("/tasks/2", "DELETE"), params("2"));
    expect(del.status).toBe(403);
    expect(await json(del)).toMatchObject({ error: "forbidden_delete", message: "Only an admin or an owner can delete a task." });
    as(PEOPLE.nina);
    expect((await task.DELETE(req("/tasks/2", "DELETE"), params("2"))).status).toBe(200);
  });
});

describe("checks, decisions and the Log", () => {
  it("marks a check, refuses a read on it, and keeps decisions with no recommendation from the request", async () => {
    await tasks.POST(req("/tasks", "POST", { title: "Call the auditor", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-20" } }));
    const read = await checks.POST(req("/checks", "POST", { ref: 1, action: "read", read: "better" }));
    expect(read.status).toBe(409);
    expect(await json(read)).toMatchObject({ error: "read_not_measure" });
    expect((await checks.POST(req("/checks", "POST", { ref: 1, action: "checked" }))).status).toBe(200);
    expect((await checks.POST(req("/checks", "POST", { ref: 1, action: "read" }))).status).toBe(400);
    const d = await decisions.POST(req("/decisions", "POST", { ref: 1, question: "Type 1 or Type 2?", options: ["Type 1", "Type 2"], chosen: "a" }));
    expect(d.status).toBe(201);
    expect((await json(d)).row.decision).toMatchObject({ recommended: null, agreed: null });
    const forged = await decisions.POST(req("/decisions", "POST", { ref: 1, question: "Type 1 or Type 2?", options: ["Type 1", "Type 2"], chosen: "a", recommended: { option: "a", by: { kind: "vizzy" }, reason: "x" } }));
    expect(forged.status).toBe(400);
  });

  it("logs an entry and reads the day", async () => {
    const r = await logRoute.POST(req("/log", "POST", { workstream: "Pricing page", state: "doing", note: "Plans and credits" }));
    expect(r.status).toBe(201);
    const day = await json(await logRoute.GET(req("/log")));
    expect(day.entries.map((e: { workstream: string }) => e.workstream)).toEqual(["Pricing page"]);
    expect(day.inFlight).toHaveLength(1);
    expect((await logRoute.GET(req("/log?day=2099-01-01"))).status).toBe(400);
    expect((await logRoute.POST(req("/log", "POST", { workstream: "", state: "doing" }))).status).toBe(400);
  });
});

describe("import", () => {
  const TAB = "MVP\tRef\tBacklog item\tStatus\nYes\t12\tRegister the company\tDone\n\t64\tInterview 5 team admins\tWIP";

  it("previews, then imports, for admins and owners only", async () => {
    const p = await importRoute.POST(req("/import", "POST", { mode: "preview", text: TAB }));
    expect(p.status).toBe(200);
    expect((await json(p)).total).toBe(2);
    const done = await importRoute.POST(req("/import", "POST", { mode: "import", text: TAB, file: "Backlog.csv" }));
    expect(done.status).toBe(201);
    expect(await json(done)).toMatchObject({ imported: 2, nextRef: 65 });
    as(PEOPLE.sam);
    const member = await importRoute.POST(req("/import", "POST", { mode: "import", text: TAB }));
    expect(member.status).toBe(403);
    expect(await json(member)).toMatchObject({ error: "forbidden_import" });
  });

  it("reads the body only up to its cap", async () => {
    const big = await importRoute.POST(req("/import", "POST", { mode: "preview", text: "a".repeat(3_200_000) }));
    expect(big.status).toBe(400);
    expect(await json(big)).toMatchObject({ error: "import_too_big" });
  });
});
