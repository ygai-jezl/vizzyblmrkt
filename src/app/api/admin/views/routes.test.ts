import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { commitSettingsChange, settingsDocId } from "@/lib/tenant";
import { takeRunSlot } from "@/lib/views/source";
import { emptyView } from "@/lib/views/types";

// Views on People (CRM_VIEWS_ENABLED): the switch, same origin and a session for everything;
// admins for team views; rate limits; and a brand only ever sees its own views and people.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const run = await import("./run/route");
const rows = await import("./rows/route");
const views = await import("./route");
const one = await import("./[viewId]/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const member = { ...admin, userId: "u_member", role: "member" };
const theirAdmin = { ...admin, tenantId: "ten_B", userId: "u_theirs" };

const req = (path: string, method = "GET", body?: unknown, origin = "http://localhost") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin, host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (viewId: string) => ({ params: Promise.resolve({ viewId }) });

const TYPE = "fld_type00000001";
const WHOLESALE = { ...emptyView(), columns: ["person", TYPE, "last_active"], filters: [{ on: TYPE, op: "any_of", value: ["opt_whole001"] }] };

let db: FakeFirestore;

function person(n: number, tenantId: string, over: Record<string, unknown> = {}) {
  const activeAt = new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();
  const id = `ct_${tenantId}_${n}`;
  db.seed("contacts", id, { tenantId, email: `p${n}@example.com`, memberOf: ["all"], reach: "yes", activeAt, sortKey: `${activeAt}|${id}`, firstSeenAt: activeAt, ...over });
  return id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRateLimitState();
  db = new FakeFirestore();
  store.db = db;
  for (const [k, v] of Object.entries({
    AUDIENCE_PERSON_LINKS_ENABLED: "true",
    AUDIENCE_ONE_VIEW_ENABLED: "true",
    ONTOLOGY_PERSON_IDS_ENABLED: "true",
    AUDIENCE_FIELDS_ENABLED: "true",
    CRM_VIEWS_ENABLED: "true",
  }))
    vi.stubEnv(k, v);
  session.getAdminContext.mockResolvedValue(admin);
  // The brand's People fields: one select.
  await commitSettingsChange(
    admin as never,
    {
      subject: "fields:person",
      baseRev: 0,
      value: {
        items: [
          {
            key: TYPE,
            label: "Customer type",
            type: "select",
            object: "person",
            options: [{ id: "opt_whole001", label: "Wholesale" }],
            archivedAt: null,
            createdAt: "2026-11-01T00:00:00.000Z",
            createdBy: null,
          },
        ],
      },
      by: { type: "member", id: "u_admin" },
      source: "editor",
    },
    db,
  );
  const tag = `field:${TYPE}:opt_whole001`;
  person(1, "ten_A", { memberOf: ["all", tag], fields: { [TYPE]: "opt_whole001" } });
  person(2, "ten_A");
  person(3, "ten_A", { memberOf: ["all", tag], fields: { [TYPE]: "opt_whole001" } });
  person(4, "ten_B", { memberOf: ["all", tag], fields: { [TYPE]: "opt_whole001" } });
});
afterEach(() => vi.unstubAllEnvs());

const runView = (body: unknown = { definition: WHOLESALE }) => run.POST(req("/api/admin/views/run", "POST", body));
const save = (body: unknown) => views.POST(req("/api/admin/views", "POST", body));

describe("the views routes", () => {
  it("don't exist while the switch is off, or without fields", async () => {
    vi.stubEnv("CRM_VIEWS_ENABLED", "false");
    expect((await runView()).status).toBe(404);
    expect((await rows.POST(req("/api/admin/views/rows", "POST", { ids: [], columns: [] }))).status).toBe(404);
    expect((await views.GET(req("/api/admin/views"))).status).toBe(404);
    expect((await save({ scope: "me", name: "X", definition: emptyView() })).status).toBe(404);
    expect((await one.PATCH(req("/x", "PATCH", { version: 1, name: "X" }), params("viw_000000000001"))).status).toBe(404);
    expect((await one.DELETE(req("/x", "DELETE", { version: 1 }), params("viw_000000000001"))).status).toBe(404);
    vi.stubEnv("CRM_VIEWS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect((await runView()).status).toBe(404);
  });

  it("need a session from this site", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await runView()).status).toBe(401);
    expect((await views.GET(req("/api/admin/views"))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await run.POST(req("/api/admin/views/run", "POST", { definition: WHOLESALE }, "https://evil.example.com"))).status).toBe(403);
  });

  it("run a view for anyone on the team: the count, the group, every match and the first rows", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await runView();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ count: 2, total: 2, capped: false, start: { kind: "group", tag: `field:${TYPE}:opt_whole001` }, ids: ["ct_ten_A_3", "ct_ten_A_1"] });
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(["ct_ten_A_3", "ct_ten_A_1"]);
    expect(body.rows[0].fields).toEqual({ [TYPE]: "opt_whole001" });
    // Another brand's people are never counted or read.
    session.getAdminContext.mockResolvedValue(theirAdmin);
    expect((await (await runView({ definition: emptyView() })).json()).ids).toEqual(["ct_ten_B_4"]);
  });

  it("refuse a bad view with 400, and are busy past two runs at once", async () => {
    expect((await runView({ definition: { ...emptyView(), columns: ["last_active"] } })).status).toBe(400);
    expect((await runView({ definition: { ...emptyView(), filters: [{ on: TYPE, op: "between", value: [9, 1] }] } })).status).toBe(400);
    expect((await runView({ nope: true })).status).toBe(400);
    const a = takeRunSlot();
    const b = takeRunSlot();
    const busy = await runView();
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "views_busy" });
    a!();
    b!();
    expect((await runView()).status).toBe(200);
  });

  it("limit runs to 20 a minute for each member", async () => {
    for (let i = 0; i < 20; i++) expect((await runView({ definition: emptyView() })).status).toBe(200);
    const res = await runView({ definition: emptyView() });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // Another member still runs theirs.
    session.getAdminContext.mockResolvedValue(member);
    expect((await runView({ definition: emptyView() })).status).toBe(200);
  });

  it("read rows by id with the chosen columns, never another brand's", async () => {
    const res = await rows.POST(req("/api/admin/views/rows", "POST", { ids: ["ct_ten_A_1", "ct_ten_B_4", "ct_ten_A_2"], columns: ["person", TYPE] }));
    expect(res.status).toBe(200);
    expect((await res.json()).rows.map((r: { id: string }) => r.id)).toEqual(["ct_ten_A_1", "ct_ten_A_2"]);
    expect((await rows.POST(req("/api/admin/views/rows", "POST", { ids: Array.from({ length: 51 }, (_, i) => `ct_${i}`), columns: [] }))).status).toBe(400);
  });

  it("save team views for admins only, and Only me views for anyone", async () => {
    const team = await save({ scope: "team", name: "Wholesale", definition: WHOLESALE });
    expect(team.status).toBe(200);
    const { view } = await team.json();
    expect(view).toMatchObject({ scope: "team", name: "Wholesale", version: 1 });

    session.getAdminContext.mockResolvedValue(member);
    const denied = await save({ scope: "team", name: "Mine", definition: WHOLESALE });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "admins_only" });
    expect((await save({ scope: "me", name: "Mine", definition: WHOLESALE })).status).toBe(200);
    // A member changing or archiving a team view: 403.
    expect((await one.PATCH(req("/x", "PATCH", { version: 1, name: "Renamed" }), params(view.id))).status).toBe(403);
    expect((await one.DELETE(req("/x", "DELETE", { version: 1 }), params(view.id))).status).toBe(403);
    const list = await (await views.GET(req("/api/admin/views"))).json();
    expect(list).toMatchObject({ team: [{ name: "Wholesale" }], archived: [], mine: [{ name: "Mine" }], canSaveTeam: false });
  });

  it("refuse typed words, naming the filters, and a bad view or name", async () => {
    const typed = await save({ scope: "me", name: "Domain", definition: { ...emptyView(), filters: [{ on: "email_domain", op: "equals", value: "greenroom-cafe.example" }] } });
    expect(typed.status).toBe(400);
    expect(await typed.json()).toEqual({ error: "typed_words", filters: [0] });
    expect((await save({ scope: "me", name: "Bad", definition: { ...emptyView(), filters: [{ on: "fld_gone00000001", op: "empty" }] } })).status).toBe(400);
    expect((await save({ scope: "everyone", name: "Bad", definition: emptyView() })).status).toBe(400);
    expect((await save({ scope: "me", name: "  ", definition: emptyView() })).status).toBe(400);
  });

  it("change, archive and bring back a team view, with 409 for one changed since it was opened", async () => {
    const { view } = await (await save({ scope: "team", name: "Wholesale", definition: WHOLESALE })).json();
    const renamed = await one.PATCH(req("/x", "PATCH", { version: 1, name: "Wholesale buyers" }), params(view.id));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).view).toMatchObject({ name: "Wholesale buyers", version: 2 });
    const stale = await one.PATCH(req("/x", "PATCH", { version: 1, name: "Stale" }), params(view.id));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "view_changed" });
    expect((await one.DELETE(req("/x", "DELETE", { version: 2 }), params(view.id))).status).toBe(200);
    expect((await (await views.GET(req("/api/admin/views"))).json()).archived).toEqual([expect.objectContaining({ id: view.id, archived: true })]);
    const back = await one.PATCH(req("/x", "PATCH", { version: 3, archived: false }), params(view.id));
    expect(back.status).toBe(200);
    expect((await back.json()).view).toMatchObject({ archived: false, version: 4 });
    expect((await one.PATCH(req("/x", "PATCH", { version: 4 }), params(view.id))).status).toBe(400);
  });

  it("answer 404 for another brand's view, another member's own view and a bad id", async () => {
    const { view } = await (await save({ scope: "team", name: "Wholesale", definition: WHOLESALE })).json();
    const { view: mine } = await (await save({ scope: "me", name: "Mine", definition: WHOLESALE })).json();
    session.getAdminContext.mockResolvedValue(theirAdmin);
    expect((await one.PATCH(req("/x", "PATCH", { version: 1, name: "Taken" }), params(view.id))).status).toBe(404);
    expect((await one.DELETE(req("/x", "DELETE", { version: 1 }), params(view.id))).status).toBe(404);
    expect((await (await views.GET(req("/api/admin/views"))).json()).team).toEqual([]);
    session.getAdminContext.mockResolvedValue({ ...admin, userId: "u_admin2" });
    expect((await one.PATCH(req("/x", "PATCH", { version: 1, name: "Taken" }), params(mine.id))).status).toBe(404);
    expect((await one.PATCH(req("/x", "PATCH", { version: 1, name: "X" }), params("../etc"))).status).toBe(404);
    // The team list document is the brand's own: settingsDocId keys it by brand.
    expect(db.raw("saved_views", settingsDocId("ten_A", "views:person"))).toMatchObject({ tenantId: "ten_A" });
  });

  it("limit team saves to 30 an hour for a brand", async () => {
    for (let i = 0; i < 30; i++) expect((await save({ scope: "team", name: `View ${i}`, definition: emptyView() })).status).toBe(200);
    const res = await save({ scope: "team", name: "One more", definition: emptyView() });
    expect(res.status).toBe(429);
    // Only me views have their own limit.
    expect((await save({ scope: "me", name: "Mine", definition: emptyView() })).status).toBe(200);
  });
});
