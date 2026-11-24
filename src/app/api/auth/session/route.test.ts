import { beforeEach, describe, expect, it, vi } from "vitest";

// The door's answers map to status codes and bodies; sign out everywhere revokes, then clears.
const session = vi.hoisted(() => ({
  ensureAdminAccess: vi.fn(),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
  getHomeAdminContext: vi.fn(),
  revokeAllSessions: vi.fn(async (_uid: string) => {}),
}));
vi.mock("@/lib/auth/session", () => session);

const { POST, DELETE } = await import("./route");
const { WORKSPACE_NOT_SET_UP_MESSAGE } = await import("@/lib/auth/accessDenied");

const URL_ = "http://localhost/api/auth/session";
const post = (body: unknown) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const del = (query = "", headers: Record<string, string> = {}) =>
  new Request(`${URL_}${query}`, { method: "DELETE", headers: { host: "localhost", ...headers } });
const home = { tenantId: "ten_demo", region: "us", userId: "u1", role: "admin", source: "idtoken" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/session", () => {
  it("400s without an ID token, before checking anything", async () => {
    for (const body of [{}, { idToken: "" }, { idToken: 42 }, "not json"]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_id_token" });
    }
    expect(session.ensureAdminAccess).not.toHaveBeenCalled();
  });

  it("401s when the token can't be verified", async () => {
    session.ensureAdminAccess.mockRejectedValue(new Error("auth/id-token-revoked"));
    const res = await POST(post({ idToken: "t" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_id_token" });
  });

  it.each([
    ["forbidden", 403, { error: "access_denied" }],
    ["not_set_up", 403, { error: "workspace_not_set_up", message: WORKSPACE_NOT_SET_UP_MESSAGE }],
    ["email_not_verified", 403, { error: "email_not_verified" }],
    ["google_only", 403, { error: "google_only" }],
    ["sign_in_again", 409, { error: "sign_in_again" }],
    ["needs_refresh", 200, { needsRefresh: true }],
  ])("answers %s with %i and no cookie", async (access, status, body) => {
    session.ensureAdminAccess.mockResolvedValue(access);
    const res = await POST(post({ idToken: "t" }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(session.createSession).not.toHaveBeenCalled();
  });

  it("makes the session once the account is ready", async () => {
    session.ensureAdminAccess.mockResolvedValue("ready");
    const res = await POST(post({ idToken: "t" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(session.ensureAdminAccess).toHaveBeenCalledWith("t");
    expect(session.createSession).toHaveBeenCalledWith("t");
  });

  it("401s when the session cookie can't be made", async () => {
    session.ensureAdminAccess.mockResolvedValue("ready");
    session.createSession.mockRejectedValueOnce(new Error("too old"));
    expect((await POST(post({ idToken: "t" }))).status).toBe(401);
  });
});

describe("DELETE /api/auth/session", () => {
  it("signs this browser out with no query, as before", async () => {
    const res = await DELETE(del());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(session.destroySession).toHaveBeenCalledTimes(1);
    expect(session.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("signs out everywhere: revokes the account's tokens, then clears the cookies", async () => {
    session.getHomeAdminContext.mockResolvedValue(home);
    const res = await DELETE(del("?scope=everywhere", { origin: "http://localhost", "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(session.revokeAllSessions).toHaveBeenCalledWith("u1");
    expect(session.destroySession).toHaveBeenCalledTimes(1);
    expect(session.revokeAllSessions.mock.invocationCallOrder[0]).toBeLessThan(session.destroySession.mock.invocationCallOrder[0]!);
  });

  it("refuses a cross-site sign out everywhere", async () => {
    session.getHomeAdminContext.mockResolvedValue(home);
    const crossSite = await DELETE(del("?scope=everywhere", { "sec-fetch-site": "cross-site" }));
    expect(crossSite.status).toBe(403);
    const badOrigin = await DELETE(del("?scope=everywhere", { origin: "https://elsewhere.test" }));
    expect(badOrigin.status).toBe(403);
    expect(session.revokeAllSessions).not.toHaveBeenCalled();
    expect(session.destroySession).not.toHaveBeenCalled();
  });

  it("401s sign out everywhere without a valid session", async () => {
    for (const ctx of [null, { ...home, userId: undefined }]) {
      session.getHomeAdminContext.mockResolvedValue(ctx);
      const res = await DELETE(del("?scope=everywhere"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(session.revokeAllSessions).not.toHaveBeenCalled();
    expect(session.destroySession).not.toHaveBeenCalled();
  });

  it("500s and keeps this browser signed in when revoking fails", async () => {
    session.getHomeAdminContext.mockResolvedValue(home);
    session.revokeAllSessions.mockRejectedValueOnce(new Error("unavailable"));
    const res = await DELETE(del("?scope=everywhere"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sign_out_failed" });
    expect(session.destroySession).not.toHaveBeenCalled();
  });

  it("400s an unknown scope and signs nothing out", async () => {
    const res = await DELETE(del("?scope=elsewhere"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_scope" });
    expect(session.destroySession).not.toHaveBeenCalled();
    expect(session.revokeAllSessions).not.toHaveBeenCalled();
  });
});
