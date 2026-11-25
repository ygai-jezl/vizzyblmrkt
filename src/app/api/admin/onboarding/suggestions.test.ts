import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// Keep or remove what Vizzy heard in a chat: origin, switch, sign-in, admin, id, input, limit, in
// that order. The brand is always the session's. The database is the in-memory fake behind every
// store.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);

const route = await import("./suggestions/[actionId]/route");
const { suggestBusinessFact, openFactSuggestions } = await import("@/lib/onboarding/factSuggestions");
const store = await import("@/lib/onboarding/store");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "usr_other", role: "admin" };
const MEMBER: TenantContext = { ...A, userId: "usr_member", role: "member" };

let db: FakeFirestore;
let actionId: string;

const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`http://localhost/api/admin/onboarding/suggestions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ actionId: id }) },
  );

beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
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
      businessProfile: { status: "done", answers: {}, rev: 0, startedAt: "2026-11-01T00:00:00.000Z" },
    });
  }
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(A);
  const r = await suggestBusinessFact(A, { kind: "timeline", text: "Gift boxes before the winter fair", quote: "We want gift boxes ready before the winter fair.", asked: "Anything coming up?" }, { db });
  if (!r.ok) throw new Error(r.error);
  actionId = r.fact.id;
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/onboarding/suggestions/[actionId]", () => {
  it("503s with the switch off, before sign-in is read", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await post(actionId, { decision: "keep" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "onboarding_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("403s a request from another site, 401s signed out and 403s a member", async () => {
    expect((await post(actionId, { decision: "keep" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await post(actionId, { decision: "keep" })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await post(actionId, { decision: "keep" })).status).toBe(403);
    expect(await store.listBusinessFacts(A, { db })).toEqual([]);
  });

  it.each([
    ["no body", undefined],
    ["another decision", { decision: "maybe" }],
    ["the fact's words instead", { decision: "keep", text: "Made up words" }],
  ])("400s %s", async (_name, body) => {
    const res = await post(actionId, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_input");
  });

  it("400s an id that can't be one, and 404s another brand's", async () => {
    expect((await post("aa_nope", { decision: "keep" })).status).toBe(400);
    session.getAdminContext.mockResolvedValue(B);
    const res = await post(actionId, { decision: "keep" });
    expect(res.status).toBe(404);
    expect(await store.listBusinessFacts(B, { db })).toEqual([]);
    expect(await store.listBusinessFacts(A, { db })).toEqual([]);
  });

  it("keeps it, answering with the fact and the chat as the section lists them, then 409s a second decision", async () => {
    const res = await post(actionId, { decision: "keep" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      fact: { id: expect.stringMatching(/^bf_/), kind: "timeline", text: "Gift boxes before the winter fair", quote: "We want gift boxes ready before the winter fair.", source: "chat", heardAt: expect.any(String) },
      conversation: { id: expect.stringMatching(/^oc_/), source: "chat", startedAt: expect.any(String), lengthSec: 0, turnCount: 3 },
    });
    expect(JSON.stringify(body)).not.toContain("ten_A");
    expect(await openFactSuggestions(A, { db })).toEqual([]);
    const again = await post(actionId, { decision: "remove" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_decided" });
  });

  it("removes it, keeping nothing", async () => {
    const res = await post(actionId, { decision: "remove" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await store.listBusinessFacts(A, { db })).toEqual([]);
  });

  it("429s over the limit, before deciding", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await post(actionId, { decision: "keep" })).status).toBe(429);
    expect(await openFactSuggestions(A, { db })).toHaveLength(1);
  });
});
