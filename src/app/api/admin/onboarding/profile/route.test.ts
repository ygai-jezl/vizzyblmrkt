import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The brand's profile: origin, switch, sign-in, admin, a strict body, a per-admin limit. The brand
// is always the session's.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const control = vi.hoisted(() => ({
  setBusinessProfile: vi.fn(async (_id: string, patch: { answers?: Record<string, string>; status?: string; via?: string }) => ({
    before: { status: "started", answers: {}, rev: 0, startedAt: "2026-11-25T10:00:00.000Z" },
    after: { status: patch.status ?? "started", answers: patch.answers ?? {}, rev: 1, startedAt: "2026-11-25T10:00:00.000Z" },
  })),
}));
vi.mock("@/lib/tenant/control", () => control);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);

const { PUT } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/onboarding/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/onboarding/profile", () => {
  it("503s with the switch off, before anything else", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    const res = await PUT(req({ answers: { who: "solo" }, via: "questions" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "onboarding_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(control.setBusinessProfile).not.toHaveBeenCalled();
  });

  it("403s a request from another site", async () => {
    const res = await PUT(req({ answers: { who: "solo" }, via: "questions" }, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req({ answers: { who: "solo" }, via: "questions" }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const res = await PUT(req({ answers: { who: "solo" }, via: "questions" }));
    expect(res.status).toBe(403);
    expect(control.setBusinessProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["no via", { answers: { who: "solo" } }],
    ["nothing to save", { via: "questions" }],
    ["empty answers", { answers: {}, via: "questions" }],
    ["an answer that isn't a choice", { answers: { who: "robot" }, via: "questions" }],
    ["a cleared answer", { answers: { who: null }, via: "settings" }],
    ["an unknown question", { answers: { colour: "blue" }, via: "settings" }],
    ["going back to started", { status: "started", via: "welcome" }],
    ["a brand in the body", { answers: { who: "solo" }, via: "questions", tenantId: "ten_B" }],
  ])("400s for %s", async (_label, body) => {
    const res = await PUT(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", issues: expect.any(Array) });
    expect(control.setBusinessProfile).not.toHaveBeenCalled();
  });

  it("saves a pick for the session's brand, saying it came from the questions", async () => {
    const res = await PUT(req({ answers: { run: "shop" }, via: "questions" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profile: { answers: { run: "shop" } } });
    expect(control.setBusinessProfile).toHaveBeenCalledWith("ten_A", { answers: { run: "shop" }, via: "questions" });
    expect(limits.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_admin", expect.objectContaining({ prefix: "onboarding_profile" }));
  });

  it("finishes with all the answers, and skips from the welcome without a via", async () => {
    await PUT(req({ answers: { who: "team", want: "audience" }, status: "done", via: "questions" }));
    expect(control.setBusinessProfile).toHaveBeenLastCalledWith("ten_A", {
      answers: { who: "team", want: "audience" },
      status: "done",
      via: "questions",
    });
    const res = await PUT(req({ status: "skipped", via: "welcome" }));
    expect(res.status).toBe(200);
    expect(control.setBusinessProfile).toHaveBeenLastCalledWith("ten_A", { status: "skipped" });
  });

  it("404s when the brand is gone, and 429s over the limit", async () => {
    control.setBusinessProfile.mockResolvedValueOnce(null as never);
    expect((await PUT(req({ status: "done", via: "questions" }))).status).toBe(404);
    limits.isRateLimited.mockResolvedValueOnce(true);
    const res = await PUT(req({ status: "done", via: "questions" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
