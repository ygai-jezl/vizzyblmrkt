import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings › Mailchimp: members can read it (never the key), only admins change it. A brand
// can only claim an audience it proves it owns, because the webhook sends that audience's
// unsubscribes, bounces and spam reports to whichever brand holds its id. requiresOwnApiKey
// can be turned on here, never off.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(),
  updateTenantConfig: vi.fn(),
  getTenantsByMailchimpAudience: vi.fn(),
}));
vi.mock("@/lib/tenant", () => tenant);
const client = vi.hoisted(() => ({ getAudience: vi.fn() }));
vi.mock("@/lib/mailchimp/client", () => client);

const { GET, PUT } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const SHARED = "shared-list-1";
const OWN_KEY = "made-up-test-key-us21";
const req = (method: string, body?: unknown, site?: string) =>
  new Request("http://localhost/api/admin/settings/mailchimp", {
    method,
    headers: { "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const brand = (mailchimpConfig?: Record<string, unknown>) => ({ id: "ten_A", region: "us", mailchimpConfig });
const saved = () => tenant.updateTenantConfig.mock.calls[0]?.[1]?.mailchimpConfig as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAILCHIMP_AUDIENCE_ID", SHARED);
  vi.stubEnv("MAILCHIMP_KEY_SEALED_ENABLED", "");
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getTenantById.mockResolvedValue(brand());
  tenant.getTenantsByMailchimpAudience.mockResolvedValue([]);
  client.getAudience.mockResolvedValue({ ok: true, data: { id: "own-list" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/settings/mailchimp", () => {
  it("a member can read it, and never sees the key", async () => {
    session.getAdminContext.mockResolvedValue(member);
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ apiKeySet: true, audienceId: "own-list" });
    expect(JSON.stringify(body)).not.toContain(OWN_KEY);
  });
});

describe("PUT /api/admin/settings/mailchimp: who", () => {
  it("403s a cross-site request before reading the session", async () => {
    expect((await PUT(req("PUT", { requiresOwnApiKey: false }, "cross-site"))).status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req("PUT", { requiresOwnApiKey: false }))).status).toBe(401);
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("403s a member and saves nothing", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await PUT(req("PUT", { requiresOwnApiKey: true, apiKey: OWN_KEY, audienceId: "own-list" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
    expect(client.getAudience).not.toHaveBeenCalled();
  });

  it("an admin saves to their own brand only", async () => {
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    expect(res.status).toBe(200);
    expect(tenant.updateTenantConfig).toHaveBeenCalledTimes(1);
    expect(tenant.updateTenantConfig.mock.calls[0]![0]).toBe("ten_A");
    expect(saved()).toMatchObject({ requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" });
    expect(client.getAudience).toHaveBeenCalledWith({ apiKey: OWN_KEY, serverPrefix: "us21", audienceId: "own-list" });
  });
});

describe("PUT /api/admin/settings/mailchimp: claiming an audience", () => {
  it("refuses the shared audience", async () => {
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: ` ${SHARED} ` }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "audience_reserved" });
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
    expect(client.getAudience).not.toHaveBeenCalled();
  });

  it("refuses an audience another brand holds, without naming it", async () => {
    tenant.getTenantsByMailchimpAudience.mockResolvedValue([{ id: "ten_B", tenantName: "Other Co" }]);
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "their-list" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "audience_in_use" });
    expect(JSON.stringify(body)).not.toMatch(/ten_B|Other Co/);
    expect(tenant.getTenantsByMailchimpAudience).toHaveBeenCalledWith("their-list");
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("lets a brand claim an audience only it holds", async () => {
    tenant.getTenantsByMailchimpAudience.mockResolvedValue([{ id: "ten_A" }]);
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    expect(res.status).toBe(200);
  });

  it("refuses an audience with no own key to go with it", async () => {
    let res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "abc123" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "own_key_required" });
    // Clearing the key in the same save counts as no key.
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY }));
    res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: "", audienceId: "abc123" }));
    expect(res.status).toBe(400);
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
    expect(client.getAudience).not.toHaveBeenCalled();
  });

  it("uses the saved key when the request doesn't send one", async () => {
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY, serverPrefix: "us9" }));
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "own-list" }));
    expect(res.status).toBe(200);
    expect(client.getAudience).toHaveBeenCalledWith({ apiKey: OWN_KEY, serverPrefix: "us9", audienceId: "own-list" });
  });

  it("refuses an audience the key can't read", async () => {
    client.getAudience.mockResolvedValue({ ok: false, reason: "Resource Not Found", status: 404 });
    let res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "not-mine" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "audience_not_yours" });
    client.getAudience.mockResolvedValue({ ok: false, reason: "API Key Invalid", status: 401 });
    res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "not-mine" }));
    expect(res.status).toBe(400);
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("502s when Mailchimp doesn't answer, and saves nothing", async () => {
    client.getAudience.mockResolvedValue({ ok: false, reason: "timeout" });
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mailchimp_unreachable" });
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("an unchanged audience makes no Mailchimp call, so an old setup can be saved again", async () => {
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, audienceId: "own-list" }));
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "own-list" }));
    expect(res.status).toBe(200);
    expect(client.getAudience).not.toHaveBeenCalled();
    expect(tenant.getTenantsByMailchimpAudience).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ audienceId: "own-list" });
  });
});

describe("PUT /api/admin/settings/mailchimp: the server prefix", () => {
  // The key is sent to <prefix>.api.mailchimp.com, so "example.test#" would send it to
  // example.test instead. Only a data centre such as us21 is taken.
  it.each(["example.test#", "example.test/", "example.test?", "us21.example.test", "us 21", "us"])(
    "refuses %j before any Mailchimp call or save, even with the saved key",
    async (serverPrefix) => {
      tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY }));
      const res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "own-list", serverPrefix }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_server_prefix" });
      expect(client.getAudience).not.toHaveBeenCalled();
      expect(tenant.getTenantsByMailchimpAudience).not.toHaveBeenCalled();
      expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
    },
  );

  it("refuses a bad prefix even when the audience is unchanged", async () => {
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "own-list", serverPrefix: "example.test#" }));
    expect(res.status).toBe(400);
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("refuses a bad prefix saved before this check, with no Mailchimp call", async () => {
    tenant.getTenantById.mockResolvedValue(
      brand({ requiresOwnApiKey: false, apiKey: OWN_KEY, serverPrefix: "example.test#" }),
    );
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, audienceId: "own-list" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_server_prefix" });
    expect(client.getAudience).not.toHaveBeenCalled();
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("refuses a key whose suffix isn't a data centre", async () => {
    const res = await PUT(
      req("PUT", { requiresOwnApiKey: false, apiKey: "made-up-test-key-example.test#", audienceId: "own-list" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_server_prefix" });
    expect(client.getAudience).not.toHaveBeenCalled();
  });

  it("takes a data centre, trimmed, and checks the claim there", async () => {
    const res = await PUT(req("PUT", { requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list", serverPrefix: " us9 " }));
    expect(res.status).toBe(200);
    expect(client.getAudience).toHaveBeenCalledWith({ apiKey: OWN_KEY, serverPrefix: "us9", audienceId: "own-list" });
    expect(saved()).toMatchObject({ serverPrefix: "us9" });
  });
});

describe("PUT /api/admin/settings/mailchimp: requiresOwnApiKey", () => {
  it("can't be turned off here", async () => {
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: true, apiKey: OWN_KEY, audienceId: "own-list" }));
    const res = await PUT(req("PUT", { requiresOwnApiKey: false }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "requires_own_key_locked" });
    expect(tenant.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("can be turned on", async () => {
    tenant.getTenantById.mockResolvedValue(brand({ requiresOwnApiKey: false, apiKey: OWN_KEY, audienceId: "own-list" }));
    const res = await PUT(req("PUT", { requiresOwnApiKey: true }));
    expect(res.status).toBe(200);
    expect(saved()).toMatchObject({ requiresOwnApiKey: true, apiKey: OWN_KEY, audienceId: "own-list" });
  });
});
