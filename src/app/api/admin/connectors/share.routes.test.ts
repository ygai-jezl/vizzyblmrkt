import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { __resetShareTokens } from "@/lib/connectors/shareAccess";

// The share access routes: start share access (make the connection's Google address) and Check
// access. Switch off answers 404 before the session is read; members, signed out and cross-site
// requests are refused. Google is never called: the app's own token is a stub and the global fetch
// that src/lib/security/ssrf.ts uses plays IAM, IAM Credentials and Search Console.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return "made-up-app-token";
    }
  },
}));

const shareRoute = await import("./[connectorId]/share/route");
const accessRoute = await import("./connections/[connectionId]/access/route");
const one = await import("./connections/[connectionId]/route");

const ORIGIN = "https://app.yougrow.test";
const PROJECT = "made-up-identities";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/admin/connectors${path}`, {
    method,
    headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

let db: FakeFirestore;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  __resetShareTokens();
  db = new FakeFirestore();
  store.db = db;
  let n = 5000;
  fetchMock = vi.fn(async (url: string | URL, init: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "iam.googleapis.com" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      return answer({ email: `${body.accountId}@${PROJECT}.iam.gserviceaccount.com`, uniqueId: String(n++) });
    }
    if (u.hostname === "iam.googleapis.com" && init.method === "DELETE") return answer({});
    if (u.hostname === "iamcredentials.googleapis.com") return answer({ accessToken: "made-up-minted", expireTime: new Date(Date.now() + 300_000).toISOString() });
    if (u.hostname === "searchconsole.googleapis.com") return answer({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }] });
    return answer({}, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT);
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const share = (headers: Record<string, string> = {}) => shareRoute.POST(req("POST", "/search-console/share", {}, headers), p({ connectorId: "search-console" }));
const access = (id: string) => accessRoute.POST(req("POST", `/connections/${id}/access`), p({ connectionId: id }));

describe("the share access routes", () => {
  it("answer 404 with CONNECTORS_ENABLED off, before reading the session", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect((await share()).status).toBe(404);
    expect((await access("dcn_aaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse members, the signed out and a cross-site request", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await share()).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await share()).status).toBe(401);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await share({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("make the address, check access and disconnect, deleting it", async () => {
    const res = await share();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { connection: { id: string }; share: { email: string; role: string } };
    expect(body.share.role).toBe("Restricted");
    expect(body.share.email).toMatch(/@made-up-identities\.iam\.gserviceaccount\.com$/);
    const checked = await access(body.connection.id);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ visible: true, accounts: [{ id: "sc-domain:example.com" }] });
    const gone = await one.DELETE(req("DELETE", `/connections/${body.connection.id}`), p({ connectionId: body.connection.id }));
    expect(await gone.json()).toMatchObject({ addressDeleted: true });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("https://iam.googleapis.com/") && (c[1] as RequestInit).method === "DELETE")).toBe(true);
  });

  it("hide share access without the identities project", async () => {
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "");
    expect((await share()).status).toBe(404);
  });
});
