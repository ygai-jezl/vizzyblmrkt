import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { StrategySuggestion } from "@/lib/types/brandStrategy";

// Not now on the month's suggestion: origin, the switch (which needs How it went and the strategy),
// sign-in, admin, the brand's limit, then the reason. The store runs for real on a fake database, so
// the decision and the hold it keeps are checked here too.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const fake = vi.hoisted(() => ({ db: null as unknown as FakeFirestore, calls: 0 }));
vi.mock("@/lib/brandStrategy/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/brandStrategy/store")>();
  return {
    ...real,
    dismissSuggestion: (ctx: Parameters<typeof real.dismissSuggestion>[0], input: Parameters<typeof real.dismissSuggestion>[1]) => {
      fake.calls += 1;
      return real.dismissSuggestion(ctx, input, { db: fake.db, now: () => new Date("2027-01-05T10:00:00.000Z") });
    },
  };
});
const review = vi.hoisted(() => ({ forgetReviewCount: vi.fn() }));
vi.mock("@/lib/review/summary", () => review);

const { POST } = await import("./route");
const { readBrandStrategyDoc } = await import("@/lib/brandStrategy/store");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", email: "ana.admin@example.com", role: "admin" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/admin/brand-kit/map/strategy/suggestion/dismiss", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

/** A made-up open suggestion: connect a tool for visits. */
const SUGGESTION: StrategySuggestion = {
  key: "sug_visits1",
  about: "visits",
  month: "2026-12",
  raisedAt: "2027-01-02T00:10:00.000Z",
  detail: { kind: "measure_more", outcome: "visits", why: "not_connected", connectors: [{ connectorId: "google-analytics", name: "Google Analytics 4", href: "/admin/account/connections/google-analytics" }] },
  keyWord: null,
  basedOn: { builtIn: ["connections"], measured: [] },
  cantSee: [],
  state: "open",
  actedAt: null,
  dismissedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.db = new FakeFirestore();
  fake.calls = 0;
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "STRATEGY_RESULTS_ENABLED", "STRATEGY_SUGGEST_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
  fake.db.seed("brand_strategy", "bst_ten_A", { tenantId: "ten_A", rev: 3, approved: null, suggestion: SUGGESTION });
  fake.db.seed("brand_strategy", "bst_ten_B", { tenantId: "ten_B", rev: 1, approved: null, suggestion: SUGGESTION });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/map/strategy/suggestion/dismiss", () => {
  it("503s with its switch off, or How it went off, before sign-in", async () => {
    vi.stubEnv("STRATEGY_SUGGEST_ENABLED", "false");
    const r = await post({ key: SUGGESTION.key, reason: "other" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "strategy_suggest_disabled" });
    vi.stubEnv("STRATEGY_SUGGEST_ENABLED", "true");
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "false");
    expect((await post({ key: SUGGESTION.key, reason: "other" })).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, a signed out person, a member and a brand past its limit", async () => {
    const body = { key: SUGGESTION.key, reason: "other" };
    expect((await post(body, { origin: "https://elsewhere.example.com", "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post(body)).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    const member = await post(body);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: "forbidden" });
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await post(body)).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "strategy_suggest" }), expect.anything());
    expect(fake.calls).toBe(0);
  });

  it("400s a reason it doesn't know, a note over 200 characters, or anything else in the body", async () => {
    for (const body of [
      { key: SUGGESTION.key, reason: "too_busy" },
      { key: SUGGESTION.key },
      { key: SUGGESTION.key, reason: "other", note: "x".repeat(201) },
      { key: SUGGESTION.key, reason: "other", tenantId: "ten_B" },
      { reason: "other" },
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_input" });
    }
    expect(fake.calls).toBe(0);
  });

  it("puts off the signed-in brand's suggestion, logs why with the note, starts the hold, and clears the Review count", async () => {
    const r = await post({ key: SUGGESTION.key, reason: "numbers_wrong", note: "  We count bookings by phone,\nnot on the site. " });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, dismissed: true });
    const doc = (await readBrandStrategyDoc({ ...admin, tenantId: "ten_A" } as never, { db: fake.db }))!;
    expect(doc.rev).toBe(3);
    expect(doc.suggestion).toMatchObject({ state: "dismissed", dismissedAt: "2027-01-05T10:00:00.000Z" });
    expect(doc.suggestHolds).toEqual([{ kind: "measure_more", about: "visits", until: "2027-04-05T10:00:00.000Z", reason: "numbers_wrong" }]);
    expect(doc.decisions).toEqual([
      { kind: "suggestion_dismissed", ref: "measure_more:visits", before: "numbers_wrong", after: "We count bookings by phone, not on the site.", at: "2027-01-05T10:00:00.000Z", by: "ana.admin@example.com" },
    ]);
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_A");
    // Another brand's suggestion is left alone, and a second Not now finds nothing open.
    expect((await readBrandStrategyDoc({ ...admin, tenantId: "ten_B" } as never, { db: fake.db }))!.suggestion?.state).toBe("open");
    expect(await (await post({ key: SUGGESTION.key, reason: "other" })).json()).toEqual({ ok: true, dismissed: false });
  });

  it("puts off nothing when the key is an older suggestion's", async () => {
    expect(await (await post({ key: "sug_older", reason: "not_a_priority" })).json()).toEqual({ ok: true, dismissed: false });
    expect((await readBrandStrategyDoc({ ...admin, tenantId: "ten_A" } as never, { db: fake.db }))!.suggestion?.state).toBe("open");
  });
});
