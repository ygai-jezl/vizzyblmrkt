import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorld, ctx, member, switchesOn, type World } from "@/lib/settings/testing/world";

// Settings › History's routes: the switch (404), same origin, a session (401), then the admin role
// for a preview or a restore (403). Anyone on the team lists and exports. The brand is the session's.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => ({ getUsers: async () => ({ users: [] }) }) }));
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const list = await import("./route");
const preview = await import("./preview/route");
const restore = await import("./restore/route");
const exporter = await import("./export/route");

let w: World;
beforeEach(async () => {
  vi.clearAllMocks();
  switchesOn();
  w = await buildWorld();
  store.db = w.db;
  session.getAdminContext.mockResolvedValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost/api/admin/settings-history${path}`, { headers: { host: "localhost", ...headers } });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/settings-history/restore", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("/api/admin/settings-history", () => {
  it("doesn't exist with its switch off", async () => {
    vi.stubEnv("SETTINGS_HISTORY_ENABLED", "false");
    expect((await list.GET(get(""))).status).toBe(404);
    expect((await preview.GET(get("/preview?subject=fields:person&rev=1"))).status).toBe(404);
    expect((await restore.POST(post({ subject: "fields:person", rev: 1, base: 4 }))).status).toBe(404);
    expect((await exporter.GET(get("/export?subject=fields:person&rev=1"))).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, then anyone signed out", async () => {
    expect((await list.GET(get("", { origin: "https://evil.example" }))).status).toBe(403);
    expect((await restore.POST(post({ subject: "fields:person", rev: 1, base: 4 }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await list.GET(get(""))).status).toBe(401);
    expect((await restore.POST(post({ subject: "fields:person", rev: 1, base: 4 }))).status).toBe(401);
  });

  it("lists the session's brand only, whatever the request names, and pages", async () => {
    const res = await list.GET(get("?tenantId=ten_other&kind=fields"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }>; next: string | null };
    expect(body.entries.map((e) => e.name)).toEqual(["People fields", "People fields", "Company fields", "People fields", "People fields"]);
    expect((await list.GET(get("?kind=nope"))).status).toBe(400);
    expect((await list.GET(get("?cursor=zzz"))).status).toBe(400);
  });

  it("lets a member list and export, but not preview or restore", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await list.GET(get(""))).status).toBe(200);
    const file = await exporter.GET(get("/export?subject=fields:person&rev=1"));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="people-fields-v1.json"');
    expect(JSON.parse(await file.text())).toMatchObject({ format: "yougrow.settings-version", rev: 1 });
    expect((await preview.GET(get("/preview?subject=fields:person&rev=1"))).status).toBe(403);
    expect((await restore.POST(post({ subject: "fields:person", rev: 1, base: 4 }))).status).toBe(403);
  });

  it("previews and restores for an admin, and answers 409 once the setting moved on", async () => {
    const p = await preview.GET(get("/preview?subject=fields:person&rev=1"));
    expect(p.status).toBe(200);
    const { preview: shown } = (await p.json()) as { preview: { base: number } };
    expect(shown.base).toBe(4);
    const done = await restore.POST(post({ subject: "fields:person", rev: 1, base: shown.base }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, rev: 5 });
    const stale = await restore.POST(post({ subject: "fields:person", rev: 1, base: shown.base }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "fields_changed" });
  });

  it("refuses bad input, a kind that is off, and shared connections", async () => {
    expect((await restore.POST(post({ subject: "fields:person", rev: "1", base: 4 }))).status).toBe(400);
    expect((await restore.POST(post({ subject: "people:all", rev: 1, base: 4 }))).status).toBe(400);
    expect((await restore.POST(post({ subject: "fields:person", rev: 1, base: 4, tenantId: "ten_other" }))).status).toBe(400);
    expect((await preview.GET(get("/preview?subject=fields:person"))).status).toBe(400);
    expect((await restore.POST(post({ subject: "connections:shared", rev: 1, base: 1 }))).status).toBe(409);
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect((await preview.GET(get("/preview?subject=fields:person&rev=1"))).status).toBe(404);
    expect((await exporter.GET(get("/export?subject=fields:person&rev=1"))).status).toBe(404);
  });
});
