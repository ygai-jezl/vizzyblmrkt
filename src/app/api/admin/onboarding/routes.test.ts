import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Learned } from "@/lib/types/onboarding";

// Confirm, read and delete a kept conversation, and remove a kept fact: origin, switch (confirm
// only), sign-in, admin, input, limit, in that order. The brand is always the session's. The
// database is the in-memory fake behind every store.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);

const conversation = await import("./conversations/[id]/route");
const confirm = await import("./conversations/[id]/confirm/route");
const facts = await import("./facts/[factId]/route");
const store = await import("@/lib/onboarding/store");
const { getTenantById } = await import("@/lib/tenant");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_other", role: "admin" };
const MEMBER: TenantContext = { ...A, userId: "usr_member", role: "member" };

const LEARNED: Learned = {
  answers: {
    who: { value: "solo", words: "It's just me." },
    run: { value: "app", words: "a note app" },
    stage: { value: null, words: "" },
    want: { value: "waitlist", words: "Knowing if people actually want it" },
  },
  facts: [
    { id: "f0", kind: "start", text: "A design prototype, no app yet", quote: "All I have is a design prototype." },
    { id: "f1", kind: "constraint", text: "Evenings only, around a day job", quote: "I've got a day job, so it's evenings." },
  ],
  model: "text-model",
  at: "2026-11-25T10:05:00.000Z",
};

let db: FakeFirestore;
let convId: string;

function seedTenants() {
  for (const id of ["ten_A", "ten_B"]) {
    db.seed("tenants", id, {
      tenantName: `Brand ${id}`,
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  }
}

async function endedConversation(ctx: TenantContext): Promise<string> {
  const started = await store.startConversation(ctx, { model: "live" }, { db });
  if (!started.ok) throw new Error(started.error);
  const id = started.value.id;
  await store.appendTurns(ctx, id, { from: 0, turns: [{ who: "vizzy", text: "Hi!", atSec: 0 }, { who: "member", text: "It's just me. All I have is a design prototype.", atSec: 3 }] }, { db });
  await store.endConversation(ctx, id, { reason: "person" }, { db });
  await store.saveLearned(ctx, id, LEARNED, { db });
  return id;
}

const url = (path: string) => `http://localhost/api/admin/onboarding/${path}`;
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url(path), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  seedTenants();
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(A);
  convId = await endedConversation(A);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/onboarding/conversations/[id]/confirm", () => {
  const post = (body: unknown, id = convId, headers: Record<string, string> = {}) =>
    confirm.POST(req("POST", `conversations/${id}/confirm`, body, headers), params({ id }));

  it("503s with the switch off, before sign-in is read", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await post({ answers: { who: "solo" }, keep: ["f0"] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "onboarding_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("403s a request from another site, 401s signed out and 403s a member", async () => {
    expect((await post({ answers: {}, keep: [] }, convId, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await post({ answers: {}, keep: [] })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await post({ answers: {}, keep: [] })).status).toBe(403);
    expect(await store.listBusinessFacts(A, { db })).toEqual([]);
  });

  it.each([
    ["no body", undefined],
    ["no keep", { answers: {} }],
    ["an answer that isn't a choice", { answers: { who: "robot" }, keep: [] }],
    ["a cleared answer", { answers: { who: null }, keep: [] }],
    ["a fact's words instead of its id", { answers: {}, keep: [{ text: "Made up", quote: "Words nobody said" }] }],
    ["an id that isn't a learned one", { answers: {}, keep: ["f8"] }],
    ["nine ids", { answers: {}, keep: ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f0"] }],
    ["a brand in the body", { answers: {}, keep: [], tenantId: "ten_B" }],
  ])("400s for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", issues: expect.any(Array) });
  });

  it("400s a bad id and 404s another brand's conversation", async () => {
    expect((await post({ answers: {}, keep: [] }, "oc_nope")).status).toBe(400);
    const theirs = await endedConversation(B);
    const res = await post({ answers: { who: "agency" }, keep: ["f0"] }, theirs);
    expect(res.status).toBe(404);
    expect(await store.listBusinessFacts(B, { db })).toEqual([]);
  });

  it("saves the answers and keeps the picked facts, copied from what was learned", async () => {
    const res = await post({ answers: { who: "solo", stage: "idea" }, keep: ["f1"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.profile).toMatchObject({ status: "done", via: "voice", answers: { who: "solo", stage: "idea" } });
    expect(body.kept).toEqual([expect.objectContaining({ kind: "constraint", text: LEARNED.facts[1]!.text, quote: LEARNED.facts[1]!.quote, conversationId: convId })]);
    expect(body.kept[0]).not.toHaveProperty("tenantId");
    expect((await getTenantById("ten_A", db))?.businessProfile?.answers).toEqual({ who: "solo", stage: "idea" });
    expect(limits.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_admin", expect.objectContaining({ prefix: "onboarding_confirm" }));
    // Again: nothing more.
    const again = await (await post({ answers: { who: "team" }, keep: ["f0", "f1"] })).json();
    expect(again.kept).toEqual([]);
    expect(await store.listBusinessFacts(A, { db })).toHaveLength(1);
  });

  it("starts the sidebar's Coming up when it finishes the welcome's first visit, and only then", async () => {
    // Home's first visit started the profile; Looks right finishes the welcome.
    db.seed("tenants", "ten_A", { ...db.raw("tenants", "ten_A"), businessProfile: { status: "started", answers: {}, rev: 0, startedAt: "2026-11-25T09:00:00.000Z" } });
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "pat@example.com" });
    expect((await post({ answers: { run: "shop", want: "audience" }, keep: [] })).status).toBe(200);
    expect((await getTenantById("ten_A", db))?.sidebarReveal).toMatchObject({ shown: ["content", "audience", "insights"], opened: [] });
    expect(db.raw("tenants", "ten_B")!.sidebarReveal).toBeUndefined();
  });

  it("keeps today's sidebar when the brand had finished or skipped the welcome before (Talk with Vizzy again)", async () => {
    for (const status of ["done", "skipped"]) {
      db.seed("tenants", "ten_A", { ...db.raw("tenants", "ten_A"), businessProfile: { status, answers: {}, rev: 1, startedAt: "2026-11-25T09:00:00.000Z" } });
      const id = await endedConversation(A);
      expect((await post({ answers: { want: "customers" }, keep: [] }, id)).status).toBe(200);
      expect(db.raw("tenants", "ten_A")!.sidebarReveal, status).toBeUndefined();
    }
  });

  it("409s a conversation still live, and 429s over the limit", async () => {
    const live = await store.startConversation(A, { model: "live" }, { db });
    const res = await post({ answers: {}, keep: [] }, live.ok ? live.value.id : "");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_ended" });
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await post({ answers: {}, keep: [] })).status).toBe(429);
  });
});

describe("GET and DELETE /api/admin/onboarding/conversations/[id]", () => {
  const get = (id = convId) => conversation.GET(req("GET", `conversations/${id}`), params({ id }));
  const del = (id = convId, headers: Record<string, string> = {}) => conversation.DELETE(req("DELETE", `conversations/${id}`, undefined, headers), params({ id }));

  it("reads the words of one of the brand's conversations, even with the switch off", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation).toEqual({
      id: convId,
      source: "voice",
      startedAt: expect.any(String),
      lengthSec: expect.any(Number),
      turns: [
        { who: "vizzy", text: "Hi!", atSec: 0 },
        { who: "member", text: "It's just me. All I have is a design prototype.", atSec: 3 },
      ],
    });
    expect(body.conversation).not.toHaveProperty("learned");
  });

  it("deletes one, even with the switch off, keeping the facts kept from it", async () => {
    await store.confirmLearned(A, convId, { answers: {}, keep: ["f0"] }, { db });
    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await store.getConversation(A, convId, { db })).toBeNull();
    expect(await store.listBusinessFacts(A, { db })).toHaveLength(1);
    expect((await del()).status).toBe(404);
  });

  it("401s signed out, 403s a member and a request from another site", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await del()).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await get()).status).toBe(403);
    expect((await del()).status).toBe(403);
    session.getAdminContext.mockResolvedValue(A);
    expect((await del(convId, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await store.getConversation(A, convId, { db })).not.toBeNull();
  });

  it("400s a bad id, and 404s another brand's conversation without touching it", async () => {
    expect((await get("oc_123")).status).toBe(400);
    expect((await del("../tenants/ten_B")).status).toBe(400);
    const theirs = await endedConversation(B);
    expect((await get(theirs)).status).toBe(404);
    expect((await del(theirs)).status).toBe(404);
    expect(await store.getConversation(B, theirs, { db })).not.toBeNull();
  });

  it("429s over the limit", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await get()).status).toBe(429);
  });
});

describe("DELETE /api/admin/onboarding/facts/[factId]", () => {
  const del = (factId: string) => facts.DELETE(req("DELETE", `facts/${factId}`), params({ factId }));

  it("removes a kept fact, even with the switch off, only in the session's brand", async () => {
    const mine = await store.confirmLearned(A, convId, { answers: {}, keep: ["f0", "f1"] }, { db });
    const [first] = mine.ok ? mine.value.kept : [];
    const theirsConv = await endedConversation(B);
    const theirs = await store.confirmLearned(B, theirsConv, { answers: {}, keep: ["f0"] }, { db });
    const [theirFact] = theirs.ok ? theirs.value.kept : [];

    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await del(first!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await store.listBusinessFacts(A, { db })).map((f) => f.id)).not.toContain(first!.id);
    expect((await del(theirFact!.id)).status).toBe(404);
    expect(await store.listBusinessFacts(B, { db })).toHaveLength(1);
  });

  it("401s, 403s a member, and 400s a bad id", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await del("bf_0123456789abcdef")).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await del("bf_0123456789abcdef")).status).toBe(403);
    session.getAdminContext.mockResolvedValue(A);
    expect((await del("bf_xyz")).status).toBe(400);
    expect((await del("bf_0123456789abcdef")).status).toBe(404);
  });
});
