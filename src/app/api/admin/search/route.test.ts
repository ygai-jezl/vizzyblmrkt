import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand search: switch, then sign-in, then input; the brand always comes from the session.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const query = vi.hoisted(() => ({ MAX_QUERY_CHARS: 500, searchBrand: vi.fn() }));
vi.mock("@/lib/search/query", () => query);
const sweep = vi.hoisted(() => ({ sweepBrand: vi.fn() }));
vi.mock("@/lib/search/sweep", () => sweep);
const status = vi.hoisted(() => ({ indexSummary: vi.fn(async () => ({ records: 3 })) }));
vi.mock("@/lib/search/status", () => status);

const { GET } = await import("./route");
const indexRoute = await import("./index/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const get = (qs: string) => new Request(`http://localhost/api/admin/search${qs}`, { method: "GET" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
  vi.stubEnv("SEARCH_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  session.getAdminContext.mockResolvedValue(member);
  query.searchBrand.mockResolvedValue({ ok: true, result: { hits: [], reranked: false, meaning: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/search", () => {
  it("503s with the switch off, before sign-in", async () => {
    vi.stubEnv("SEARCH_ENABLED", "");
    const res = await GET(get("?q=repot"));
    expect(res.status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(get("?q=repot"))).status).toBe(401);
  });

  it("400s on a missing query or an unknown kind", async () => {
    expect((await GET(get(""))).status).toBe(400);
    expect((await GET(get("?q=repot&kinds=people"))).status).toBe(400);
    expect((await GET(get(`?q=${"x".repeat(501)}`))).status).toBe(400);
  });

  it("lets a member search their own brand, with the kinds asked for", async () => {
    const res = await GET(get("?q=FL-204%20kit&kinds=article,post&limit=5"));
    expect(res.status).toBe(200);
    expect(query.searchBrand).toHaveBeenCalledWith(member, "FL-204 kit", { kinds: ["article", "post"], limit: 5 });
  });

  it("never takes the brand from the request", async () => {
    await GET(get("?q=repot&tenantId=ten_B"));
    expect(query.searchBrand.mock.calls[0]?.[0]).toMatchObject({ tenantId: "ten_A" });
  });

  it("403s a brand without search", async () => {
    query.searchBrand.mockResolvedValue({ ok: false, error: "not_granted" });
    const res = await GET(get("?q=repot"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "search_not_granted" });
  });
});

describe("/api/admin/search/index", () => {
  it("shows any member what the index holds", async () => {
    const res = await indexRoute.GET(new Request("http://localhost/api/admin/search/index"));
    expect(res.status).toBe(200);
    expect(status.indexSummary).toHaveBeenCalledWith(member);
  });

  it("lets only an admin rebuild", async () => {
    const post = () => new Request("http://localhost/api/admin/search/index", { method: "POST" });
    expect((await indexRoute.POST(post())).status).toBe(403);
    expect(sweep.sweepBrand).not.toHaveBeenCalled();
    session.getAdminContext.mockResolvedValue(admin);
    sweep.sweepBrand.mockResolvedValue({ indexed: 2 });
    const res = await indexRoute.POST(post());
    expect(res.status).toBe(200);
    expect(sweep.sweepBrand.mock.calls[0]?.[0]).toBe(admin);
  });

  it("503s with the switch off", async () => {
    vi.stubEnv("SEARCH_ENABLED", "");
    expect((await indexRoute.GET(new Request("http://localhost/api/admin/search/index"))).status).toBe(503);
  });
});
