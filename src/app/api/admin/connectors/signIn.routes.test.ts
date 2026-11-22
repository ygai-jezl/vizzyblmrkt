import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";

// Sign in with Google through the start and callback routes. Each refusal is checked before any
// code is swapped: a replayed state, the cookie of another browser, another brand's state, an
// expired state, a second admin finishing someone else's sign in, and a member. Google is never
// called: the global fetch that src/lib/security/ssrf.ts uses is a stub answering by address.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const startRoute = await import("./[connectorId]/start/route");
const callbackRoute = await import("./callback/route");
const accountsRoute = await import("./connections/[connectionId]/accounts/route");
const { forTenant } = await import("@/lib/tenant");
const { openConnectorSecret } = await import("@/lib/connectors/vault");

const ORIGIN = "https://app.yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin2 = { ...admin, userId: "usr_admin2" };
const member = { ...admin, userId: "usr_member", role: "member" };
const otherBrand = { ...admin, tenantId: "ten_B" };
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SITES_URL = "https://searchconsole.googleapis.com/webmasters/v3/sites";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let tokenAnswer: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;
let db: FakeFirestore;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  db = new FakeFirestore();
  store.db = db;
  tokenAnswer = () => answer({ access_token: "made-up-access", refresh_token: "made-up-refresh", expires_in: 3599, scope: SCOPE, token_type: "Bearer" });
  fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url) === TOKEN_URL) return tokenAnswer();
    if (String(url) === SITES_URL) return answer({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
    return answer({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "sign-in-route-test-vault-root-0123456789");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
  vi.stubEnv("CONNECTORS_OAUTH_ORIGIN", ORIGIN);
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function startReq(body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/admin/connectors/search-console/start`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const p = (connectorId = "search-console") => ({ params: Promise.resolve({ connectorId }) });

interface Started {
  url: URL;
  state: string;
  cookie: string;
  setCookie: string;
}

async function start(body?: unknown): Promise<Started> {
  const res = await startRoute.POST(startReq(body), p());
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { url, state: url.searchParams.get("state")!, cookie: setCookie.split(";")[0]!, setCookie };
}

function callback(query: Record<string, string>, cookie: string | null, headers: Record<string, string> = {}) {
  return callbackRoute.GET(
    new Request(`${ORIGIN}/api/admin/connectors/callback?${new URLSearchParams(query)}`, {
      headers: { host: "app.yougrow.test", "sec-fetch-site": "cross-site", ...(cookie ? { cookie } : {}), ...headers },
    }),
  );
}
const where = (res: Response) => new URL(res.headers.get("location") ?? "", ORIGIN);
const reason = (res: Response) => where(res).searchParams.get("reason");
const exchanges = () => fetchMock.mock.calls.filter((c) => String(c[0]) === TOKEN_URL).length;
const connections = () => db.dump("data_connections");

describe("starting a sign in", () => {
  it("sends the browser to Google with one scope, offline access, consent and PKCE S256, and sets its own cookie", async () => {
    const s = await start();
    expect(s.url.origin + s.url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(s.url.searchParams)).toMatchObject({
      client_id: "made-up-client.example.test",
      redirect_uri: `${ORIGIN}/api/admin/connectors/callback`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    expect(s.url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(s.cookie).toMatch(/^yg_dcs_[0-9a-f]{24}=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(s.setCookie).toMatch(/Path=\/api\/admin\/connectors\/callback/);
    expect(s.setCookie).toMatch(/SameSite=lax/i);
    expect(s.setCookie).toMatch(/HttpOnly/i);
    expect(s.setCookie).toMatch(/Secure/i);
    expect(s.setCookie).toMatch(/Max-Age=600/);
    const [nonce, verifier] = s.cookie.split("=")[1]!.split(".");
    expect(s.url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier!).digest("base64url"));
    expect(db.dump("data_connection_states")).toHaveLength(1);
    expect(db.raw("data_connection_states", createHash("sha256").update(nonce!).digest("hex"))).toMatchObject({ tenantId: "ten_A", uid: "usr_admin", usedAt: null });
  });

  it("gives every attempt its own cookie, so two tabs never clash", async () => {
    const a = await start();
    const b = await start();
    expect(a.cookie.split("=")[0]).not.toBe(b.cookie.split("=")[0]);
  });

  it("refuses a member, a cross-site start, an unknown connector, and a copy with no client or address", async () => {
    session.getAdminContext.mockResolvedValueOnce(member);
    expect((await startRoute.POST(startReq(), p())).status).toBe(403);
    expect((await startRoute.POST(startReq(undefined, { "sec-fetch-site": "cross-site", origin: "https://evil.example.test" }), p())).status).toBe(403);
    expect((await startRoute.POST(startReq(), p("cloudflare"))).status).toBe(404);
    vi.stubEnv("CONNECTORS_OAUTH_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    // No address to return to: Sign in isn't offered, so Search Console with only Sign in is hidden.
    expect((await startRoute.POST(startReq(), p())).status).toBe(404);
    // Listed for share access, Sign in still refuses, saying what is missing.
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
    const noOrigin = await startRoute.POST(startReq(), p());
    expect(noOrigin.status).toBe(503);
    expect(await noOrigin.json()).toMatchObject({ error: "signin_unconfigured" });
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "");
    expect((await startRoute.POST(startReq(), p())).status).toBe(404);
    expect(db.dump("data_connection_states")).toEqual([]);
  });

  it("keeps GA4's Sign in off behind its own switch while GA4 is offered for share access", async () => {
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
    const off = await startRoute.POST(startReq(), p("google-analytics"));
    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ error: "method_not_supported" });
    expect(db.dump("data_connection_states")).toEqual([]);
    vi.stubEnv("CONNECTOR_GA4_SIGNIN_ENABLED", "true");
    const res = await startRoute.POST(startReq(), p("google-analytics"));
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/analytics.readonly");
    // Turned off while the person was on Google's screen: the callback swaps nothing.
    vi.stubEnv("CONNECTOR_GA4_SIGNIN_ENABLED", "false");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(reason(await callback({ state: url.searchParams.get("state")!, code: "c" }, cookie))).toBe("connector_off");
    expect(exchanges()).toBe(0);
  });

  it("answers 404 with the switch off, before reading the session", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect((await startRoute.POST(startReq(), p())).status).toBe(404);
    expect((await callback({ state: "x", code: "y" }, null)).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });
});

describe("finishing a sign in", () => {
  it("works with Google's cross-site redirect: swaps the code with the verifier, checks, saves sealed, and clears the cookie", async () => {
    const s = await start();
    const res = await callback({ state: s.state, code: "made-up-code", scope: SCOPE }, s.cookie);
    expect(res.status).toBe(303);
    const to = where(res);
    expect(to.pathname).toBe("/admin/account/connections/search-console");
    expect(to.searchParams.get("status")).toBe("connected");
    const id = to.searchParams.get("connection")!;
    expect(id).toMatch(/^dcn_[a-z2-7]{20}$/);
    expect(res.headers.get("location")).not.toContain("made-up");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${s.cookie.split("=")[0]}=;.*Path=/api/admin/connectors/callback`));
    const swap = fetchMock.mock.calls.find((c) => String(c[0]) === TOKEN_URL)!;
    const sent = Object.fromEntries(new URLSearchParams(String((swap[1] as RequestInit).body)));
    expect(sent).toMatchObject({ grant_type: "authorization_code", code: "made-up-code", redirect_uri: `${ORIGIN}/api/admin/connectors/callback`, code_verifier: s.cookie.split(".")[1] });
    const conn = (await forTenant(admin as never, db).dataConnections.getById(id))!;
    expect(conn).toMatchObject({ connectorId: "search-console", method: "oauth_pkce", account: "", ownerUid: "usr_admin", status: "connected", health: { state: "ok" } });
    expect(openConnectorSecret("ten_A", id, "refresh", conn.secrets.refresh!)).toBe("made-up-refresh");
    expect(JSON.stringify(db.raw("data_connections", id))).not.toMatch(/made-up-(access|refresh)/);
    expect(db.dump("data_connection_states")).toEqual([]);
  });

  it("refuses a replayed state, with no second swap", async () => {
    const s = await start();
    expect(where(await callback({ state: s.state, code: "made-up-code" }, s.cookie)).searchParams.get("status")).toBe("connected");
    const again = await callback({ state: s.state, code: "made-up-code" }, s.cookie);
    expect(reason(again)).toBe("state_used");
    expect(exchanges()).toBe(1);
    expect(connections()).toHaveLength(1);
  });

  it("refuses the cookie of another browser, or none, and leaves the sign in for the browser that started it", async () => {
    const s = await start();
    const other = await start();
    expect(reason(await callback({ state: s.state, code: "c" }, other.cookie))).toBe("wrong_browser");
    expect(reason(await callback({ state: s.state, code: "c" }, null))).toBe("wrong_browser");
    const forged = `${s.cookie.split("=")[0]}=${other.cookie.split("=")[1]}`;
    expect(reason(await callback({ state: s.state, code: "c" }, forged))).toBe("wrong_browser");
    expect(exchanges()).toBe(0);
    expect(where(await callback({ state: s.state, code: "c" }, s.cookie)).searchParams.get("status")).toBe("connected");
  });

  it("refuses another brand's state, even with its own cookie", async () => {
    const s = await start();
    session.getAdminContext.mockResolvedValue(otherBrand);
    expect(reason(await callback({ state: s.state, code: "c" }, s.cookie))).toBe("bad_state");
    expect(reason(await callback({ state: "forged.state", code: "c" }, s.cookie))).toBe("bad_state");
    expect(exchanges()).toBe(0);
  });

  it("refuses a state older than 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    const s = await start();
    vi.setSystemTime(new Date("2026-11-21T10:10:01.000Z"));
    expect(reason(await callback({ state: s.state, code: "c" }, s.cookie))).toBe("state_expired");
    expect(exchanges()).toBe(0);
  });

  it("refuses a second admin finishing someone else's sign in, and a member", async () => {
    const s = await start();
    session.getAdminContext.mockResolvedValue(admin2);
    expect(reason(await callback({ state: s.state, code: "c" }, s.cookie))).toBe("wrong_admin");
    session.getAdminContext.mockResolvedValue(member);
    const res = await callback({ state: s.state, code: "c" }, s.cookie);
    expect(where(res).pathname).toBe("/admin/account/connections");
    expect(reason(res)).toBe("forbidden");
    session.getAdminContext.mockResolvedValue(null);
    expect(where(await callback({ state: s.state, code: "c" }, s.cookie)).pathname).toBe("/login");
    expect(exchanges()).toBe(0);
    session.getAdminContext.mockResolvedValue(admin);
    expect(where(await callback({ state: s.state, code: "c" }, s.cookie)).searchParams.get("status")).toBe("connected");
  });

  it("uses up the sign in when Google says access was denied", async () => {
    const s = await start();
    expect(reason(await callback({ state: s.state, error: "access_denied" }, s.cookie))).toBe("denied");
    expect(reason(await callback({ state: s.state, code: "c" }, s.cookie))).toBe("state_used");
    expect(exchanges()).toBe(0);
  });

  it("saves nothing when the scope wasn't granted, more was granted, no refresh token came or the check failed", async () => {
    const cases: Array<[() => Response, string]> = [
      [() => answer({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: "openid" }), "scope_not_granted"],
      [() => answer({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: `${SCOPE} https://www.googleapis.com/auth/analytics.readonly` }), "scope_too_wide"],
      [() => answer({ access_token: "a", expires_in: 3599, scope: SCOPE }), "no_refresh_token"],
      [() => answer({ error: "invalid_grant" }, 400), "exchange_failed"],
    ];
    for (const [tokens, why] of cases) {
      tokenAnswer = tokens;
      const s = await start();
      expect(reason(await callback({ state: s.state, code: "c" }, s.cookie)), why).toBe(why);
    }
    tokenAnswer = () => answer({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: SCOPE });
    fetchMock.mockImplementation(async (url: string | URL) => (String(url) === TOKEN_URL ? tokenAnswer() : answer({ error: { status: "UNAUTHENTICATED" } }, 401)));
    const s = await start();
    expect(reason(await callback({ state: s.state, code: "c" }, s.cookie))).toBe("check_failed");
    expect(connections()).toEqual([]);
  });

  it("signs an existing connection in again, keeping its site and history", async () => {
    const first = await start();
    const id = where(await callback({ state: first.state, code: "c1" }, first.cookie)).searchParams.get("connection")!;
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(admin as never, id, () => ({ patch: { account: "sc-domain:example.com", health: { state: "broken", lastOkAt: null, lastCheckedAt: null, lastErrorCode: "signin_refused", failures: 1, pausedUntil: null } }, activity: [] }), db);
    tokenAnswer = () => answer({ access_token: "made-up-access-2", refresh_token: "made-up-refresh-2", expires_in: 3599, scope: SCOPE });
    const again = await start({ connectionId: id });
    const res = await callback({ state: again.state, code: "c2" }, again.cookie);
    expect(Object.fromEntries(where(res).searchParams)).toEqual({ status: "connected", connection: id, reconnected: "1" });
    const conn = (await forTenant(admin as never, db).dataConnections.getById(id))!;
    expect(conn).toMatchObject({ account: "sc-domain:example.com", health: { state: "ok" } });
    expect(openConnectorSecret("ten_A", id, "refresh", conn.secrets.refresh!)).toBe("made-up-refresh-2");
    expect(conn.recent[0]).toMatchObject({ kind: "connected", code: "signed_in_again" });
    expect(connections()).toHaveLength(1);
  });

  it("refuses to sign in again for a connection of another brand", async () => {
    const s = await start();
    const id = where(await callback({ state: s.state, code: "c" }, s.cookie)).searchParams.get("connection")!;
    session.getAdminContext.mockResolvedValue(otherBrand);
    expect((await startRoute.POST(startReq({ connectionId: id }), p())).status).toBe(404);
  });
});

describe("picking the site a sign in reads, through the accounts route", () => {
  const accountsReq = (method: "GET" | "PUT", id: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/admin/connectors/connections/${id}/accounts`, {
      method,
      headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const cp = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });
  const sitesCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === SITES_URL);
  async function signedIn(): Promise<string> {
    const s = await start();
    return where(await callback({ state: s.state, code: "c" }, s.cookie)).searchParams.get("connection")!;
  }
  const accountOf = async (id: string) => (await forTenant(admin as never, db).dataConnections.getById(id))!.account;

  it("answers 404 with the switch off, before reading the session", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect((await accountsRoute.GET(accountsReq("GET", "dcn_aaaaaaaaaaaaaaaaaaaa"), cp("dcn_aaaaaaaaaaaaaaaaaaaa"))).status).toBe(404);
    expect((await accountsRoute.PUT(accountsReq("PUT", "dcn_aaaaaaaaaaaaaaaaaaaa", { account: "sc-domain:example.com" }), cp("dcn_aaaaaaaaaaaaaaaaaaaa"))).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses the signed out, a cross-site pick, members, a bad body and another brand's connection", async () => {
    const id = await signedIn();
    const before = sitesCalls().length;
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await accountsRoute.GET(accountsReq("GET", id), cp(id))).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com" }), cp(id))).status).toBe(401);
    const crossSite = { "sec-fetch-site": "cross-site", origin: "https://evil.example.test" };
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com" }, crossSite), cp(id))).status).toBe(403);
    expect((await accountsRoute.GET(accountsReq("GET", id, undefined, crossSite), cp(id))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(member);
    expect((await accountsRoute.GET(accountsReq("GET", id), cp(id))).status).toBe(403);
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com" }), cp(id))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "" }), cp(id))).status).toBe(400);
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com", tenantId: "ten_B" }), cp(id))).status).toBe(400);
    expect((await accountsRoute.PUT(accountsReq("PUT", id), cp(id))).status).toBe(400);
    session.getAdminContext.mockResolvedValue(otherBrand);
    expect((await accountsRoute.GET(accountsReq("GET", id), cp(id))).status).toBe(404);
    expect((await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com" }), cp(id))).status).toBe(404);
    // Nothing was asked of Google, and nothing was picked.
    expect(sitesCalls().length).toBe(before);
    expect(await accountOf(id)).toBe("");
  });

  it("lists the sites the sign in sees with its token, then picks one", async () => {
    const id = await signedIn();
    const listed = await accountsRoute.GET(accountsReq("GET", id), cp(id));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toMatchObject({ accounts: [{ id: "sc-domain:example.com" }], more: false, current: "" });
    const call = sitesCalls().at(-1)!;
    expect(((call[1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer made-up-access");
    const picked = await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:example.com" }), cp(id));
    expect(picked.status).toBe(200);
    expect(await picked.json()).toMatchObject({ id, needsAccount: false });
    expect(await accountOf(id)).toBe("sc-domain:example.com");
    // A site the sign in can't see is refused, and the pick stays.
    const refused = await accountsRoute.PUT(accountsReq("PUT", id, { account: "sc-domain:elsewhere.example.test" }), cp(id));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "account_refused" });
    expect(await accountOf(id)).toBe("sc-domain:example.com");
  });
});
