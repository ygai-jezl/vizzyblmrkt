import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audience → People (AUDIENCE_ONE_VIEW_ENABLED): the list and its groups.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const list = vi.hoisted(() => ({
  listPeople: vi.fn(async () => ({ people: [], nextCursor: null, total: 0 })),
  peopleFilters: vi.fn(async () => ({ everyone: 0, canEmail: 0, via: { form: 0, site: 0 }, launches: [], products: [] })),
}));
vi.mock("@/lib/audience/peopleList", async (actual) => ({ ...(await actual<typeof import("@/lib/audience/peopleList")>()), ...list }));

const { GET } = await import("./route");
const { GET: filters } = await import("./filters/route");

const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const member = { ...admin, role: "member" };
const req = (query = "") => new Request(`http://localhost/api/admin/audience/list${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/audience/list", () => {
  it("doesn't exist while the one view is off, or without the person records", async () => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    expect((await GET(req())).status).toBe(404);
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    expect((await GET(req())).status).toBe(404);
    expect((await filters(req())).status).toBe(404);
    expect(list.listPeople).not.toHaveBeenCalled();
  });

  it("needs a signed-in admin session, and members can look", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await GET(req())).status).toBe(200);
  });

  it("refuses a group it doesn't know and a cursor that isn't a time", async () => {
    expect((await GET(req("?show=everyone"))).status).toBe(400);
    expect((await GET(req("?show=launch:a%2Fb"))).status).toBe(400);
    expect((await GET(req("?cursor=yesterday"))).status).toBe(400);
    expect((await GET(req("?cursor=2026-10-01T00:00:00.000Z"))).status).toBe(400);
    expect(list.listPeople).not.toHaveBeenCalled();
  });

  it("reads the group, can-email, search and cursor for the signed-in brand", async () => {
    const cursor = "2026-10-01T00:00:00.000Z|ct_1";
    const res = await GET(req(`?show=stage:pcn_1:stuck&email=1&q=ada&cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    expect(list.listPeople).toHaveBeenCalledWith(admin, { tag: "stage:pcn_1:stuck", canEmail: true, q: "ada", cursor });
    await GET(req());
    expect(list.listPeople).toHaveBeenLastCalledWith(admin, { tag: "all", canEmail: false, q: "", cursor: null });
  });

  it("gives the brand's groups with their counts", async () => {
    const res = await filters(req());
    expect(res.status).toBe(200);
    expect(list.peopleFilters).toHaveBeenCalledWith(admin);
  });
});
