import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Removals from brand search are forced whatever the switches say (ADR-0025): an in-memory index stands in.
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));

// Brand › Competitors: switch, then sign-in, then (to change anything) admin, then the brand's access.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const access = vi.hoisted(() => ({ brandCanUse: vi.fn(async () => true) }));
vi.mock("@/lib/plans/brandAccess", () => access);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);
const review = vi.hoisted(() => ({ forgetReviewCount: vi.fn() }));
vi.mock("@/lib/review/summary", () => review);
const steps = vi.hoisted(() => ({ advanceCompetitor: vi.fn(async () => ({ id: "cmp_abcdef123456" })) }));
vi.mock("@/lib/competitors/steps", () => steps);

const COMPETITOR = {
  id: "cmp_abcdef123456",
  tenantId: "ten_A",
  name: "Acme Dental",
  website: "https://acme-dental.example",
  site: "acme-dental.example",
  nameId: null,
  status: "finding",
  stage: "plain",
  problem: null,
  failures: 0,
  sitemap: null,
  read: null,
  analysis: null,
  relabel: false,
  news: null,
  nextPostsCheckAt: null,
  nextSiteCheckAt: null,
  lastPostsCheckAt: null,
  lastSiteCheckAt: null,
  leaseUntil: null,
  leaseId: null,
  addedBy: null,
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
};
const store = vi.hoisted(() => ({
  listCompetitors: vi.fn(async () => []),
  getCompetitor: vi.fn(),
  listChanges: vi.fn(async () => []),
  listPosts: vi.fn(async () => []),
  unseenChanges: vi.fn(async () => []),
  onBrandMap: vi.fn(async () => new Set<string>()),
  monitorCompetitor: vi.fn(),
  updateCompetitor: vi.fn(),
  removeCompetitor: vi.fn(),
  retryCompetitor: vi.fn(),
  checkNow: vi.fn(),
  addToBrandMap: vi.fn(),
  markSeen: vi.fn(async () => 2),
}));
vi.mock("@/lib/competitors/store", () => store);
const strategy = vi.hoisted(() => ({ logStrategyDecisions: vi.fn(async () => true), noteMonitored: vi.fn(async () => true), readBrandStrategyDoc: vi.fn(async (): Promise<unknown> => null), fullRunsInMonth: vi.fn(() => 0) }));
vi.mock("@/lib/brandStrategy/store", () => strategy);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn(async () => null) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), getTenantById: tenants.getTenantById }));

const { GET, POST } = await import("./route");
const item = await import("./[competitorId]/route");
const { POST: SEEN } = await import("./seen/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/competitors", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({ competitorId: "cmp_abcdef123456" }) };
const MONITOR = { website: "acme-dental.example", name: "Acme Dental" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COMPETITORS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  access.brandCanUse.mockResolvedValue(true);
  limits.isRateLimited.mockResolvedValue(false);
  store.monitorCompetitor.mockResolvedValue({ ok: true, value: { competitor: COMPETITOR, brandMap: "added" } });
  store.getCompetitor.mockResolvedValue(COMPETITOR);
  store.checkNow.mockResolvedValue({ ok: true, value: COMPETITOR });
  store.updateCompetitor.mockResolvedValue({ ok: false, status: 400, error: "not_on_their_site" });
  store.removeCompetitor.mockResolvedValue({ ok: true, value: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("the Competitors APIs", () => {
  it("503 with the switch off, before sign-in", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "");
    expect((await GET(req("GET"))).status).toBe(503);
    expect((await POST(req("POST", MONITOR))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("let a member read but not change, and nobody signed out", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await GET(req("GET"))).status).toBe(200);
    expect((await item.GET(req("GET"), params)).status).toBe(200);
    expect((await POST(req("POST", MONITOR))).status).toBe(403);
    expect((await item.PATCH(req("PATCH", { paused: true }), params)).status).toBe(403);
    expect((await item.POST(req("POST", { action: "check" }), params)).status).toBe(403);
    expect((await item.DELETE(req("DELETE"), params)).status).toBe(403);
    expect((await SEEN(req("POST", {}))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
    expect(store.monitorCompetitor).not.toHaveBeenCalled();
  });

  it("403 not_included for a brand without the feature", async () => {
    access.brandCanUse.mockResolvedValue(false);
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_included" });
  });

  it("Monitor: checks the input, the rate, then starts watching and does the first steps", async () => {
    expect((await POST(req("POST", { website: "acme-dental.example", name: "" }))).status).toBe(400);
    expect((await POST(req("POST", { website: "acme-dental.example", name: "Two\nlines" }))).status).toBe(400);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req("POST", MONITOR))).status).toBe(429);
    const ok = await POST(req("POST", MONITOR));
    expect(ok.status).toBe(201);
    expect(store.monitorCompetitor).toHaveBeenCalledWith(admin, MONITOR, {});
    expect(steps.advanceCompetitor).toHaveBeenCalledWith(admin, "cmp_abcdef123456", expect.any(Number), {});
    expect(await ok.json()).toMatchObject({ brandMap: "added", competitor: { id: "cmp_abcdef123456", status: "finding" } });
  });

  it("pass the store's refusals on", async () => {
    store.monitorCompetitor.mockResolvedValueOnce({ ok: false, status: 409, error: "already_watching", id: "cmp_other0000001" });
    const dup = await POST(req("POST", MONITOR));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "already_watching", id: "cmp_other0000001" });
    expect((await item.PATCH(req("PATCH", { newsUrl: "https://elsewhere.example" }), params)).status).toBe(400);
    expect((await item.PATCH(req("PATCH", {}), params)).status).toBe(400);
    store.getCompetitor.mockResolvedValueOnce(null);
    expect((await item.GET(req("GET"), params)).status).toBe(404);
  });

  it("Check now is rate limited per competitor, and Mark seen resets the Review count", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await item.POST(req("POST", { action: "check" }), params)).status).toBe(429);
    expect(store.checkNow).not.toHaveBeenCalled();
    expect((await item.POST(req("POST", { action: "check" }), params)).status).toBe(200);
    expect((await item.POST(req("POST", { action: "explode" }), params)).status).toBe(400);
    const seen = await SEEN(req("POST", { competitorId: "cmp_abcdef123456" }));
    expect(await seen.json()).toEqual({ ok: true, marked: 2 });
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_A");
    expect((await SEEN(req("POST", { competitorId: "../etc" }))).status).toBe(400);
  });

  it("leave a group out while the strategy isn't joined to Competitors, as any field it didn't know", async () => {
    expect((await item.PATCH(req("PATCH", { group: "most" }), params)).status).toBe(400);
    expect((await item.PATCH(req("PATCH", { group: "everything", paused: true }), params)).status).toBe(400);
    expect(store.updateCompetitor).toHaveBeenLastCalledWith(admin, "cmp_abcdef123456", { paused: true }, {});
    await POST(req("POST", { ...MONITOR, group: "most" }));
    expect(store.monitorCompetitor).toHaveBeenLastCalledWith(admin, MONITOR, {});
    expect(strategy.logStrategyDecisions).not.toHaveBeenCalled();
    expect(strategy.noteMonitored).not.toHaveBeenCalled();
  });

  it("joined: a group a person changes is kept, and logged on the strategy before and after", async () => {
    for (const [k, v] of Object.entries({ BRAND_MAP_ENABLED: "true", BRAND_STRATEGY_ENABLED: "true", STRATEGY_COMPETITORS_ENABLED: "true" })) vi.stubEnv(k, v);
    store.updateCompetitor.mockResolvedValue({ ok: true, value: { ...COMPETITOR, group: "big" } });
    expect((await item.PATCH(req("PATCH", { group: "everything" }), params)).status).toBe(400);
    expect((await item.PATCH(req("PATCH", { group: "big" }), params)).status).toBe(200);
    expect(store.updateCompetitor).toHaveBeenLastCalledWith(admin, "cmp_abcdef123456", { group: "big" }, {});
    expect(strategy.logStrategyDecisions).toHaveBeenCalledWith(admin, [{ kind: "competitor_grouped", ref: "Acme Dental", before: null, after: "big" }], {});
    // The same group again changes nothing to log.
    store.getCompetitor.mockResolvedValue({ ...COMPETITOR, group: "big" });
    strategy.logStrategyDecisions.mockClear();
    await item.PATCH(req("PATCH", { group: "big" }), params);
    expect(strategy.logStrategyDecisions).not.toHaveBeenCalled();
    // Monitor carries the finder's group, and one the finder suggested is kept as a tick.
    expect((await POST(req("POST", { ...MONITOR, group: "most" }))).status).toBe(201);
    expect(store.monitorCompetitor).toHaveBeenLastCalledWith(admin, { ...MONITOR, group: "most" }, {});
    expect(strategy.noteMonitored).toHaveBeenCalledWith(admin, { name: "Acme Dental", site: "acme-dental.example" }, {});
    session.getAdminContext.mockResolvedValue(member);
    expect((await item.PATCH(req("PATCH", { group: "most" }), params)).status).toBe(403);
  });

  it("joined, the list carries the finder's suggestions that aren't watched or left out; off, it doesn't", async () => {
    store.listCompetitors.mockResolvedValue([COMPETITOR] as never);
    strategy.readBrandStrategyDoc.mockResolvedValue({
      rev: 3,
      draft: { competitorGroups: [{ kind: "big", competitors: [{ name: "Alpha", site: "alpha.example", foundTimes: 2, evidence: [], ticked: false, from: "finder" }, { name: "Acme Dental", site: "acme-dental.example", foundTimes: 1, evidence: [], ticked: false, from: "finder" }, { name: "Left", site: "left.example", foundTimes: 1, evidence: [], ticked: false, from: "finder" }] }] },
      approved: null,
      finder: { quickAt: null, fullRuns: [], notCompetitors: [{ name: "Left", site: null }] },
    });
    const off = (await (await GET(req("GET"))).json()) as Record<string, unknown>;
    expect(Object.keys(off)).toEqual(["competitors"]);
    for (const [k, v] of Object.entries({ BRAND_MAP_ENABLED: "true", BRAND_STRATEGY_ENABLED: "true", STRATEGY_COMPETITORS_ENABLED: "true" })) vi.stubEnv(k, v);
    const on = (await (await GET(req("GET"))).json()) as { competitors: Array<{ id: string }>; suggestions: Array<{ name: string; group: string }> };
    expect(on.competitors.map((c) => c.id)).toEqual(["cmp_abcdef123456"]);
    expect(on.suggestions).toEqual([{ name: "Alpha", site: "alpha.example", group: "big", foundTimes: 2, evidence: [] }]);
    // Its record has no group: the draft's "big" comes as a hint only, never as its group.
    expect((on as unknown as { was: Record<string, string> }).was).toEqual({ cmp_abcdef123456: "big" });
    expect((on.competitors[0] as { group?: string }).group).toBeUndefined();
    store.listCompetitors.mockResolvedValue([]);
  });

  it("Stop watching removes it and resets the Review count", async () => {
    expect((await item.DELETE(req("DELETE"), params)).status).toBe(200);
    expect(store.removeCompetitor).toHaveBeenCalledWith(admin, "cmp_abcdef123456", {});
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_A");
  });
});
