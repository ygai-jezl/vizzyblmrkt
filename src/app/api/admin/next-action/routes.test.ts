import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// Your next action's routes: origin, switch, sign-in, admin, input, limit, in that order. The brand
// is always the session's. The database is the in-memory fake behind every store, and the model a
// stub through gemini.ts.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);
const model = vi.hoisted(() => ({ answer: null as string | null, calls: 0 }));
vi.mock("@/lib/agents/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/gemini")>()),
  generateJsonWithSchema: vi.fn(async () => {
    model.calls += 1;
    return model.answer;
  }),
}));

const compose = await import("./route");
const outcome = await import("./outcome/route");
const { readNextActionCard } = await import("@/lib/tenant");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const MEMBER: TenantContext = { ...A, userId: "usr_member", role: "member" };

let db: FakeFirestore;

const GOOD = {
  steps: [
    { title: "Start your first email list", why: "You said Christmas markets: open the gift box waitlist this week.", action: "ask.waitlist_page", button: "Draft it with Vizzy" },
    { title: "Create your first idea", why: "You said you want to test it before you build it.", action: "page.create_launch", button: "Create it" },
  ],
  note: "",
};

const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`http://localhost/api/admin/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  model.answer = JSON.stringify(GOOD);
  model.calls = 0;
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
      businessProfile: { status: "done", answers: { run: "shop" }, rev: 0, startedAt: "2026-11-01T00:00:00.000Z" },
    });
  }
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(A);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/next-action", () => {
  it("503s with the switch off (or onboarding off), before sign-in is read", async () => {
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "");
    let res = await post(compose, "next-action", { reason: "state" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "next_action_disabled" });
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
    vi.stubEnv("ONBOARDING_ENABLED", "");
    res = await post(compose, "next-action", { reason: "state" });
    expect(res.status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(model.calls).toBe(0);
  });

  it("403s another site, 401s signed out, 403s a member, and 400s bad input", async () => {
    expect((await post(compose, "next-action", { reason: "state" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await post(compose, "next-action", { reason: "state" })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await post(compose, "next-action", { reason: "state" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(A);
    for (const body of [undefined, {}, { reason: "now" }, { reason: "state", tenantId: "ten_B" }]) {
      expect((await post(compose, "next-action", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(model.calls).toBe(0);
    expect(await readNextActionCard(A, { db })).toBeNull();
  });

  it("writes the card and answers with it, buttons resolved on the server; then no second call for the same inputs", async () => {
    const res = await post(compose, "next-action", { reason: "state" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { composed: boolean; view: { steps: Array<{ title: string; button: unknown }> } };
    expect(body.composed).toBe(true);
    expect(body.view.steps.map((s) => s.button)).toEqual([
      { label: "Draft it with Vizzy", href: null, prompt: "Draft a waitlist page for my idea" },
      { label: "Create it", href: "/admin/launches/new", prompt: null },
    ]);
    const again = (await (await post(compose, "next-action", { reason: "state" })).json()) as { composed: boolean };
    expect(again.composed).toBe(false);
    expect(model.calls).toBe(1);
    // Only the session's brand has a card.
    expect(await readNextActionCard({ ...A, tenantId: "ten_B" }, { db })).toBeNull();
  });

  it("answers view null for the steps list when the card fails its checks", async () => {
    model.answer = JSON.stringify({ steps: [{ ...GOOD.steps[0], action: "https://evil.example.com" }] });
    const body = (await (await post(compose, "next-action", { reason: "state" })).json()) as { view: unknown };
    expect(body.view).toBeNull();
    expect((await readNextActionCard(A, { db }))!.failure).toBe("allowlist");
  });

  it("is rate limited per admin, more tightly for Show another", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await post(compose, "next-action", { reason: "another" })).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_admin", expect.objectContaining({ prefix: "next_action_another" }));
  });
});

describe("POST /api/admin/next-action/outcome", () => {
  async function cardId(): Promise<string> {
    await post(compose, "next-action", { reason: "state" });
    return (await readNextActionCard(A, { db }))!.cardId!;
  }

  it("503s with the switch off, 401s signed out, 403s a member", async () => {
    const id = await cardId();
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "false");
    expect((await post(outcome, "next-action/outcome", { cardId: id, step: "s1", outcome: "done" })).status).toBe(503);
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(null);
    expect((await post(outcome, "next-action/outcome", { cardId: id, step: "s1", outcome: "done" })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(MEMBER);
    expect((await post(outcome, "next-action/outcome", { cardId: id, step: "s1", outcome: "done" })).status).toBe(403);
    expect((await readNextActionCard(A, { db }))!.steps[0]!.state).toBe("open");
  });

  it("400s bad input: an unknown card id shape, step or outcome, an answer with no choice, a URL in place of an id", async () => {
    const id = await cardId();
    for (const body of [
      { cardId: "nc_x", step: "s1", outcome: "done" },
      { cardId: id, step: "s4", outcome: "done" },
      { cardId: id, step: "s1", outcome: "approve" },
      { cardId: id, step: "s1", outcome: "answered" },
      { cardId: id, step: "s1", outcome: "done", href: "https://evil.example.com" },
      { cardId: id, step: "s1", outcome: "done", action: "page.review" },
      { cardId: id, step: "s1", outcome: "dismissed", reason: "x".repeat(400) },
    ]) {
      expect((await post(outcome, "next-action/outcome", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("records done and dismissed with a reason, and 409s a step already decided or an old card", async () => {
    const id = await cardId();
    expect(await (await post(outcome, "next-action/outcome", { cardId: id, step: "s1", outcome: "done" })).json()).toEqual({ ok: true, suggestion: null });
    expect((await post(outcome, "next-action/outcome", { cardId: id, step: "s1", outcome: "dismissed" })).status).toBe(409);
    expect((await post(outcome, "next-action/outcome", { cardId: id, step: "s2", outcome: "dismissed", reason: "We did this already" })).status).toBe(200);
    const rec = (await readNextActionCard(A, { db }))!;
    expect(rec.steps.map((s) => s.state)).toEqual(["done", "dismissed"]);
    expect(rec.outcomes[0]).toMatchObject({ state: "dismissed", reason: "We did this already" });
    expect((await post(outcome, "next-action/outcome", { cardId: "nc_0000000000000000", step: "s1", outcome: "done" })).status).toBe(409);
  });
});
