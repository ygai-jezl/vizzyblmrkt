import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAuthTokenParameters } from "@google/genai";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// Talk with Vizzy's routes: start, turns and end. Gemini is faked (the token client and the text
// model that learns from a call): nothing leaves the test. The database is the in-memory fake
// behind every store and the control plane.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);
const gemini = vi.hoisted(() => ({
  create: null as unknown as ReturnType<typeof vi.fn>,
  live: true,
  generate: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@/lib/agents/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/gemini")>()),
  getLiveTokenClient: () => (gemini.live ? { authTokens: { create: gemini.create } } : null),
  isLiveConfigured: () => gemini.live,
  generateTextWithDeadline: (...args: unknown[]) => gemini.generate(...args),
}));

const start = await import("./voice/start/route");
const turnsRoute = await import("./conversations/[id]/turns/route");
const endRoute = await import("./conversations/[id]/end/route");
const store = await import("@/lib/onboarding/store");
const { getTenantById } = await import("@/lib/tenant");
const { usageThisMonth } = await import("@/lib/plans/meter");
const { voiceDayOf } = await import("@/lib/types/businessProfile");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const A2: TenantContext = { ...A, userId: "usr_admin2" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_other", role: "admin" };
const MEMBER: TenantContext = { ...A, userId: "usr_member", role: "member" };

let db: FakeFirestore;
const today = () => voiceDayOf(Date.now());

function seedTenants(over: Record<string, unknown> = {}) {
  for (const id of ["ten_A", "ten_B"]) {
    db.seed("tenants", id, {
      tenantName: id === "ten_A" ? "Fernhill Plants" : "Lumen Notes",
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...(id === "ten_A" ? over : {}),
    });
  }
}

const url = (path: string) => `http://localhost/api/admin/onboarding/${path}`;
const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const postStart = (body: unknown = {}, headers: Record<string, string> = {}) => start.POST(req("voice/start", body, headers));
const postTurns = (id: string, body: unknown) => turnsRoute.POST(req(`conversations/${id}/turns`, body), params(id));
const postEnd = (id: string, body: unknown) => endRoute.POST(req(`conversations/${id}/end`, body), params(id));

/** A started call's id, through the start route as the given admin. */
async function started(ctx: TenantContext = A): Promise<string> {
  session.getAdminContext.mockResolvedValue(ctx);
  const res = await postStart();
  expect(res.status).toBe(200);
  const id = (await res.json()).conversationId as string;
  session.getAdminContext.mockResolvedValue(A);
  return id;
}

const HELLO = { who: "vizzy", text: "Hi! Tell me about Fernhill Plants.", atSec: 1 };
const SOLO = { who: "member", text: "It's just me, and I sell houseplants online.", atSec: 4 };
const SHOP = { who: "member", text: "Mostly a shop with plants and pots.", atSec: 20 };

/** What the text model says about a call: built from the member's own words, so it survives the checks. */
const LEARNED_JSON = JSON.stringify({
  answers: {
    who: { value: "solo", words: "It's just me" },
    run: { value: "shop", words: "a shop with plants and pots" },
    stage: { value: null, words: "" },
    want: { value: null, words: "" },
  },
  facts: [{ kind: "channel", text: "Sells online", quote: "I sell houseplants online" }],
});

/** A conversation doc as stored, changed (the fake keeps docs as given). */
function patchConversation(id: string, patch: Record<string, unknown>) {
  const raw = db.raw("onboarding_conversations", id)!;
  db.seed("onboarding_conversations", id, { ...raw, ...patch });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  seedTenants();
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  vi.stubEnv("ONBOARDING_VOICE_ENABLED", "true");
  vi.stubEnv("USAGE_METER_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  vi.stubEnv("PLANS_ENABLED", "");
  gemini.live = true;
  gemini.create = vi.fn(async (_: CreateAuthTokenParameters) => ({ name: "auth_tokens/test-token" }));
  gemini.generate = vi.fn(async () => LEARNED_JSON);
  session.getAdminContext.mockResolvedValue(A);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/onboarding/voice/start", () => {
  it("503s with voice off, before sign-in is read, even with onboarding on", async () => {
    vi.stubEnv("ONBOARDING_VOICE_ENABLED", "");
    const res = await postStart();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_disabled" });
    vi.stubEnv("ONBOARDING_VOICE_ENABLED", "true");
    vi.stubEnv("ONBOARDING_ENABLED", "");
    expect((await postStart()).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(gemini.create).not.toHaveBeenCalled();
  });

  it("403s another site, 401s signed out, 403s a member", async () => {
    expect((await postStart({}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await postStart()).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await postStart()).status).toBe(403);
    expect(gemini.create).not.toHaveBeenCalled();
  });

  it("400s a body that tries to shape the call", async () => {
    const res = await postStart({ model: "something-else" });
    expect(res.status).toBe(400);
    expect((await postStart("{not json")).status).toBe(400);
    expect(gemini.create).not.toHaveBeenCalled();
  });

  it("503s with no Live API key, and 403s a brand that isn't allowed it", async () => {
    gemini.live = false;
    expect(await (await postStart()).json()).toEqual({ error: "unavailable" });
    gemini.live = true;
    vi.stubEnv("GRANTED_ONLY_FEATURES", "onboarding_voice");
    const res = await postStart();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_included" });
    // Granted: allowed.
    db.seed("tenants", "ten_A", { ...db.raw("tenants", "ten_A")!, grantedFeatures: ["onboarding_voice"] });
    expect((await postStart()).status).toBe(200);
  });

  it("mints a locked token for the brand and starts its conversation", async () => {
    const res = await postStart();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      conversationId: expect.stringMatching(/^oc_[a-f0-9]{32}$/),
      token: "auth_tokens/test-token",
      model: "gemini-3.8-live",
      callSeconds: 300,
      expiresAt: expect.any(String),
    });
    const sent = (gemini.create.mock.calls[0]![0] as CreateAuthTokenParameters).config!;
    expect(sent.uses).toBe(1);
    expect(sent.liveConnectConstraints!.model).toBe("gemini-3.8-live");
    expect(String(sent.liveConnectConstraints!.config!.systemInstruction)).toContain("<brand_name>\nFernhill Plants\n</brand_name>");
    const c = await store.getConversation(A, body.conversationId, { db });
    expect(c).toMatchObject({ status: "live", source: "voice", by: "usr_admin", model: "gemini-3.8-live", tenantId: "ten_A" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toEqual({ day: today(), starts: 1, done: false });
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "onboarding_voice_start", burstLimit: 2, hourlyLimit: 4 }));
  });

  it("429s once today's call is done, and after three starts", async () => {
    seedTenants({ onboardingVoice: { day: today(), starts: 1, done: true } });
    let res = await postStart();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "voice_used_today" });
    seedTenants({ onboardingVoice: { day: today(), starts: 3, done: false } });
    res = await postStart();
    expect(await res.json()).toEqual({ error: "voice_starts_used" });
    expect(gemini.create).not.toHaveBeenCalled();
    // Yesterday's call doesn't count today.
    seedTenants({ onboardingVoice: { day: "2020-01-01", starts: 3, done: true } });
    expect((await postStart()).status).toBe(200);
  });

  it("409s at 20 kept conversations, before taking a start", async () => {
    for (let i = 0; i < 20; i += 1) {
      const id = `oc_${String(i).padStart(32, "0")}`;
      db.seed("onboarding_conversations", id, { tenantId: "ten_A", id, source: "voice", by: "usr_admin", status: "ended", startedAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-11-01T10:08:00.000Z", turns: [], notes: [] });
    }
    const res = await postStart();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "too_many_conversations" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toBeUndefined();
  });

  it("gives the start back when the token can't be made, and starts no conversation", async () => {
    gemini.create = vi.fn(async () => Promise.reject(new Error("quota exceeded")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await postStart();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toEqual({ day: today(), starts: 0, done: false });
    expect(await store.listConversations(A, { db })).toEqual([]);
    gemini.create = vi.fn(async () => ({}));
    expect((await postStart()).status).toBe(503);
    expect((await getTenantById("ten_A", db))?.onboardingVoice?.starts).toBe(0);
    warn.mockRestore();
  });

  it("closes and counts a call left open before starting another", async () => {
    const id = await started();
    const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    patchConversation(id, { startedAt, expiresAt: new Date(Date.parse(startedAt) + 8 * 60_000).toISOString() });
    expect((await postStart()).status).toBe(200);
    const closed = await store.getConversation(A, id, { db });
    expect(closed).toMatchObject({ status: "ended", endReason: "closed", meteredSeconds: 360 });
    expect((await usageThisMonth(A, { db })).voice_seconds).toMatchObject({ total: 360, calls: 1, byPurpose: { onboarding_voice: 360 } });
    // Nobody spoke on it, so the day isn't used up.
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toMatchObject({ starts: 2, done: false });
  });

  it("429s over the rate limit", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await postStart()).status).toBe(429);
    expect(gemini.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/onboarding/conversations/[id]/turns", () => {
  it("adds finished lines in order, and a repeat adds nothing", async () => {
    const id = await started();
    let res = await postTurns(id, { from: 0, turns: [HELLO, SOLO], notes: [{ topic: "who", choice: "solo", words: "just me" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, length: 2 });
    res = await postTurns(id, { from: 0, turns: [HELLO, SOLO] });
    expect(await res.json()).toEqual({ ok: true, length: 2 });
    res = await postTurns(id, { from: 1, turns: [SOLO, SHOP] });
    expect(await res.json()).toEqual({ ok: true, length: 3 });
    const c = await store.getConversation(A, id, { db });
    expect(c!.turns.map((t) => t.text)).toEqual([HELLO.text, SOLO.text, SHOP.text]);
    expect(c!.notes).toEqual([expect.objectContaining({ topic: "who", choice: "solo", words: "just me" })]);
    expect(limits.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_admin", expect.objectContaining({ prefix: "onboarding_voice_turns", burstLimit: 30, hourlyLimit: 240 }));
  });

  it("refuses a gap with the length kept", async () => {
    const id = await started();
    await postTurns(id, { from: 0, turns: [HELLO] });
    const res = await postTurns(id, { from: 3, turns: [SHOP] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "out_of_order", length: 1 });
  });

  it("404s another brand's call and 403s another admin's", async () => {
    const theirs = await started(B);
    let res = await postTurns(theirs, { from: 0, turns: [HELLO] });
    expect(res.status).toBe(404);
    const mine = await started(A);
    session.getAdminContext.mockResolvedValue(A2);
    res = await postTurns(mine, { from: 0, turns: [HELLO] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_yours" });
    expect((await store.getConversation(B, theirs, { db }))!.turns).toEqual([]);
  });

  it("409s a call that has ended or whose time has passed", async () => {
    const id = await started();
    await postEnd(id, { reason: "person" });
    let res = await postTurns(id, { from: 0, turns: [HELLO] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conversation_closed" });
    const late = await started();
    patchConversation(late, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    res = await postTurns(late, { from: 0, turns: [HELLO] });
    expect(await res.json()).toEqual({ error: "conversation_closed" });
  });

  it("413s a full conversation and a body that is too big", async () => {
    const id = await started();
    patchConversation(id, { turns: Array.from({ length: 200 }, (_, i) => ({ who: "member", text: `Line ${i}`, atSec: 1 })) });
    let res = await postTurns(id, { from: 200, turns: [SHOP] });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "conversation_full" });
    const other = await started();
    res = await postTurns(other, { from: 0, turns: [{ ...SHOP, text: "x".repeat(2000) }], pad: "y".repeat(60_000) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it.each([
    ["no turns", { from: 0, turns: [] }],
    ["21 turns", { from: 0, turns: Array.from({ length: 21 }, () => HELLO) }],
    ["a turn of 2,001 characters", { from: 0, turns: [{ ...SOLO, text: "x".repeat(2001) }] }],
    ["an unknown speaker", { from: 0, turns: [{ ...SOLO, who: "system" }] }],
    ["a note that isn't a choice", { from: 0, turns: [SOLO], notes: [{ topic: "who", choice: "shop" }] }],
    ["a brand in the body", { from: 0, turns: [SOLO], tenantId: "ten_B" }],
    ["a negative offset", { from: -1, turns: [SOLO] }],
  ])("400s %s", async (_label, body) => {
    const id = await started();
    const res = await postTurns(id, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });

  it("400s a bad id, and 503s with voice off", async () => {
    expect((await postTurns("oc_nope", { from: 0, turns: [SOLO] })).status).toBe(400);
    vi.stubEnv("ONBOARDING_VOICE_ENABLED", "false");
    expect((await postTurns(`oc_${"a".repeat(32)}`, { from: 0, turns: [SOLO] })).status).toBe(503);
  });
});

describe("POST /api/admin/onboarding/conversations/[id]/end", () => {
  it("ends with the last words, counts the call's seconds once, and learns from it", async () => {
    const id = await started();
    // Started a little over two minutes ago.
    patchConversation(id, { startedAt: new Date(Date.now() - 125_000).toISOString() });
    await postTurns(id, { from: 0, turns: [HELLO, SOLO] });
    let res = await postEnd(id, { from: 2, turns: [SHOP], notes: [{ topic: "run", choice: "shop" }], reason: "person" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lengthSec: expect.any(Number), covered: ["who", "run"], answers: { who: "solo", run: "shop" }, learned: true });
    const c = await store.getConversation(A, id, { db });
    expect(c).toMatchObject({ status: "ended", endReason: "person", learnTries: 1 });
    expect(c!.turns).toHaveLength(3);
    expect(c!.learned!.facts).toEqual([{ id: "f0", kind: "channel", text: "Sells online", quote: "I sell houseplants online" }]);
    expect(gemini.generate).toHaveBeenCalledTimes(1);
    const prompt = String(gemini.generate.mock.calls[0]![0]);
    expect(prompt).toContain("MEMBER: It's just me, and I sell houseplants online.");
    expect(prompt).toContain("run: shop");
    expect(c!.meteredSeconds).toBeGreaterThanOrEqual(125);
    expect(c!.meteredSeconds).toBeLessThan(135);
    const meter = (await usageThisMonth(A, { db })).voice_seconds;
    expect(meter).toMatchObject({ calls: 1, total: c!.meteredSeconds, byPurpose: { onboarding_voice: c!.meteredSeconds } });

    // Again: the same answer, nothing counted twice, no second model call.
    res = await postEnd(id, { reason: "person" });
    expect(res.status).toBe(200);
    expect((await res.json()).learned).toBe(true);
    expect((await usageThisMonth(A, { db })).voice_seconds).toMatchObject({ calls: 1 });
    expect(gemini.generate).toHaveBeenCalledTimes(1);
  });

  it("uses up the brand's day only when someone spoke and the call didn't drop", async () => {
    const quiet = await started();
    await postTurns(quiet, { from: 0, turns: [HELLO] });
    await postEnd(quiet, { reason: "person" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice?.done).toBe(false);
    // Nobody spoke: no model call either.
    expect(gemini.generate).not.toHaveBeenCalled();

    const dropped = await started();
    await postEnd(dropped, { from: 0, turns: [HELLO, SOLO], reason: "error" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice?.done).toBe(false);

    const spoke = await started();
    await postEnd(spoke, { from: 0, turns: [HELLO, SOLO], reason: "vizzy" });
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toMatchObject({ starts: 3, done: true });
    const res = await postStart();
    expect(await res.json()).toEqual({ error: "voice_used_today" });
  });

  it("502s when learning gives nothing, tries again on a repeat, and stops after three tries", async () => {
    const id = await started();
    patchConversation(id, { startedAt: new Date(Date.now() - 60_000).toISOString() });
    gemini.generate = vi.fn(async () => null);
    const body = { from: 0, turns: [HELLO, SOLO], reason: "time" };
    for (let i = 0; i < 3; i += 1) {
      const res = await postEnd(id, body);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "learn_failed" });
    }
    expect((await store.getConversation(A, id, { db }))!.learnTries).toBe(3);
    const res = await postEnd(id, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lengthSec: expect.any(Number), covered: [], answers: {}, learned: false });
    // Counted once, on the first end.
    expect((await usageThisMonth(A, { db })).voice_seconds).toMatchObject({ calls: 1 });
  });

  it("falls back to Vizzy's notes for what it heard when nothing was learned", async () => {
    const id = await started();
    gemini.generate = vi.fn(async () => null);
    await postTurns(id, { from: 0, turns: [HELLO, SOLO], notes: [{ topic: "who", choice: "solo" }, { topic: "want", choice: "unclear" }] });
    for (let i = 0; i < 3; i += 1) await postEnd(id, { reason: "person" });
    const res = await postEnd(id, { reason: "person" });
    expect(await res.json()).toMatchObject({ covered: ["who"], answers: { who: "solo" }, learned: false });
  });

  it("404s another brand's call and 403s another admin's, leaving them live", async () => {
    const theirs = await started(B);
    expect((await postEnd(theirs, { reason: "person" })).status).toBe(404);
    const mine = await started(A);
    session.getAdminContext.mockResolvedValue(A2);
    const res = await postEnd(mine, { reason: "person" });
    expect(res.status).toBe(403);
    expect((await store.getConversation(A, mine, { db }))!.status).toBe("live");
    expect((await store.getConversation(B, theirs, { db }))!.status).toBe("live");
    expect(await usageThisMonth(A, { db })).toEqual({});
  });

  it("400s a bad reason, turns without an offset, or a bad id; 401s signed out", async () => {
    const id = await started();
    expect((await postEnd(id, { reason: "bored" })).status).toBe(400);
    expect((await postEnd(id, { turns: [SOLO], reason: "person" })).status).toBe(400);
    expect((await postEnd(id, {})).status).toBe(400);
    expect((await postEnd("oc_1", { reason: "person" })).status).toBe(400);
    session.getAdminContext.mockResolvedValue(null);
    expect((await postEnd(id, { reason: "person" })).status).toBe(401);
  });
});
