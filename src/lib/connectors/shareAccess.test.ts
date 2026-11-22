import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetShareTokens,
  brandTag,
  copyTag,
  createShareAccount,
  deleteShareAccount,
  forgetShareTokens,
  iamFailureCode,
  identitiesProject,
  isShareAccessConfigured,
  listShareAccounts,
  MINT_BACKOFF_MS,
  newShareAccountId,
  parseShareDescription,
  shareAccessToken,
  shareDescription,
} from "./shareAccess";

// Google is never called: the transport is a fake IAM that keeps its accounts in a map, and the
// app's own token is a stub. Made-up project, brand and connection ids only.
const PROJECT = "made-up-identities";
const TENANT = "ten_example";
const CONN = "dcn_aaaaaaaaaaaaaaaaaaaa";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const NOW = new Date("2026-11-21T10:00:00.000Z");

const answer = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Account {
  email: string;
  uniqueId: string;
  description: string;
}

/** A fake IAM and IAM Credentials API. */
function fakeIam(opts: { full?: boolean; invisibleFor?: number; createStatus?: number } = {}) {
  const accounts = new Map<string, Account>();
  let n = 100000000000000000000n;
  let invisible = opts.invisibleFor ?? 0;
  const calls: Array<{ method: string; url: string; body: unknown; auth: string }> = [];
  const transport = vi.fn(async (url: string, init: RequestInit, o: { maxRedirects: number; allowedPorts: number[] }) => {
    expect(o.maxRedirects).toBe(0);
    expect(o.allowedPorts).toEqual([443]);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body, auth: String((init.headers as Record<string, string>).authorization) });
    const u = new URL(url);
    if (u.hostname === "iam.googleapis.com" && init.method === "POST") {
      if (opts.createStatus) return answer({ error: { status: "PERMISSION_DENIED", message: "Permission denied" } }, opts.createStatus);
      if (opts.full) return answer({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Maximum number of service accounts on project reached." } }, 429);
      const email = `${body.accountId}@${PROJECT}.iam.gserviceaccount.com`;
      const account = { email, uniqueId: String(n++), description: body.serviceAccount.description };
      accounts.set(account.uniqueId, account);
      return answer({ name: `projects/${PROJECT}/serviceAccounts/${email}`, projectId: PROJECT, ...account });
    }
    if (u.hostname === "iam.googleapis.com" && init.method === "DELETE") {
      const id = u.pathname.split("/").pop()!;
      if (!accounts.delete(id)) return answer({ error: { status: "NOT_FOUND" } }, 404);
      return answer({});
    }
    if (u.hostname === "iam.googleapis.com" && init.method === "GET") {
      const all = [...accounts.values()];
      const start = Number(u.searchParams.get("pageToken") || 0);
      const size = Number(u.searchParams.get("pageSize"));
      const next = start + size < all.length ? String(start + size) : undefined;
      return answer({ accounts: all.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) });
    }
    if (u.hostname === "iamcredentials.googleapis.com") {
      if (invisible > 0) {
        invisible--;
        return answer({ error: { status: "PERMISSION_DENIED" } }, 403);
      }
      return answer({ accessToken: `made-up-minted-${calls.length}`, expireTime: new Date(NOW.getTime() + 300_000).toISOString() });
    }
    return answer({}, 500);
  });
  const sleep = vi.fn(async () => {});
  return { accounts, calls, transport, sleep, deps: { transport, sleep, appToken: async () => "made-up-app-token", log: () => {}, now: NOW } };
}

beforeEach(() => __resetShareTokens());
afterEach(() => vi.unstubAllEnvs());

describe("the identities project", () => {
  it("is hidden until CONNECTORS_IDENTITIES_PROJECT names a project id", () => {
    expect(isShareAccessConfigured()).toBe(false);
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "Not A Project");
    expect(identitiesProject()).toBeNull();
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", ` ${PROJECT} `);
    expect(identitiesProject()).toBe(PROJECT);
    expect(isShareAccessConfigured()).toBe(true);
  });
});

describe("account ids and descriptions", () => {
  it("makes ids inside Google's rule that never hold the brand or the connection", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newShareAccountId();
      expect(id).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])$/);
      expect(id.length).toBeGreaterThanOrEqual(6);
      expect(id.length).toBeLessThanOrEqual(30);
      expect(id).not.toContain("ten_");
      expect(id).not.toContain("example");
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("names the connection, a one way brand tag and a one way copy tag in the description, and reads them back", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "made-up-app-project");
    const d = shareDescription(TENANT, CONN);
    expect(d).not.toContain(TENANT);
    expect(d).not.toContain("made-up-app-project");
    expect(brandTag(TENANT)).toMatch(/^[0-9a-f]{16}$/);
    expect(brandTag("ten_other")).not.toBe(brandTag(TENANT));
    expect(copyTag()).toMatch(/^[0-9a-f]{16}$/);
    expect(copyTag()).toBe(copyTag("made-up-app-project"));
    expect(copyTag("made-up-other-copy")).not.toBe(copyTag());
    expect(parseShareDescription(d)).toEqual({ connectionId: CONN, brand: brandTag(TENANT), copy: copyTag() });
    // One made before copies were tagged reads back with no copy.
    expect(parseShareDescription(`YouGrow connected data. connection=${CONN} brand=${brandTag(TENANT)}`)).toEqual({ connectionId: CONN, brand: brandTag(TENANT), copy: null });
    expect(parseShareDescription("someone else's account")).toBeNull();
    expect(parseShareDescription(undefined)).toBeNull();
    expect(d.length).toBeLessThanOrEqual(256);
  });
});

describe("making, listing and deleting addresses", () => {
  it("makes one account per connection with the app's own token, on IAM's fixed host", async () => {
    const iam = fakeIam();
    const a = await createShareAccount(PROJECT, TENANT, CONN, iam.deps);
    const b = await createShareAccount(PROJECT, TENANT, "dcn_bbbbbbbbbbbbbbbbbbbb", iam.deps);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.account.email).toMatch(/^ygc-[a-z2-7]{20}@made-up-identities\.iam\.gserviceaccount\.com$/);
    expect(a.account.email).not.toBe(b.account.email);
    expect(iam.accounts.size).toBe(2);
    const sent = iam.calls[0]!;
    expect(sent.url).toBe(`https://iam.googleapis.com/v1/projects/${PROJECT}/serviceAccounts`);
    expect(sent.auth).toBe("Bearer made-up-app-token");
    expect(sent.body).toEqual({ accountId: expect.stringMatching(/^ygc-/), serviceAccount: { displayName: "YouGrow connection", description: shareDescription(TENANT, CONN) } });
    expect(JSON.stringify(sent.body)).not.toContain(TENANT);
  });

  it("says plainly when the project is full, and when this copy's setup refuses", async () => {
    expect(await createShareAccount(PROJECT, TENANT, CONN, fakeIam({ full: true }).deps)).toMatchObject({ ok: false, code: "share_quota" });
    expect(await createShareAccount(PROJECT, TENANT, CONN, fakeIam({ createStatus: 403 }).deps)).toMatchObject({ ok: false, code: "share_unconfigured" });
    const noToken = { ...fakeIam().deps, appToken: async () => null };
    expect(await createShareAccount(PROJECT, TENANT, CONN, noToken)).toMatchObject({ ok: false, code: "share_unconfigured" });
    expect(await createShareAccount("Bad Project", TENANT, CONN, fakeIam().deps)).toMatchObject({ ok: false, code: "share_unconfigured" });
  });

  it("classifies IAM's refusals", () => {
    expect(iamFailureCode(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Maximum number of service accounts on project reached." } })).toBe("share_quota");
    expect(iamFailureCode(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for create requests per minute" } })).toBe("rate_limited");
    expect(iamFailureCode(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } })).toBe("share_unconfigured");
    expect(iamFailureCode(503, {})).toBe("provider_error");
  });

  it("deletes by unique id, counts an account already gone as done, and lists only its own accounts", async () => {
    const iam = fakeIam();
    const made = await createShareAccount(PROJECT, TENANT, CONN, iam.deps);
    if (!made.ok) throw new Error("not made");
    iam.accounts.set("999", { email: `someone@${PROJECT}.iam.gserviceaccount.com`, uniqueId: "999", description: "" });
    const listed = await listShareAccounts(PROJECT, iam.deps);
    expect(listed).toEqual({ ok: true, complete: true, accounts: [{ ...made.account, owner: { connectionId: CONN, brand: brandTag(TENANT), copy: copyTag() } }] });
    expect(await deleteShareAccount(PROJECT, made.account.uniqueId, iam.deps)).toEqual({ ok: true, gone: false });
    expect(iam.calls.at(-1)!.url).toBe(`https://iam.googleapis.com/v1/projects/${PROJECT}/serviceAccounts/${made.account.uniqueId}`);
    expect(await deleteShareAccount(PROJECT, made.account.uniqueId, iam.deps)).toEqual({ ok: true, gone: true });
    expect(await deleteShareAccount(PROJECT, "not-a-number", iam.deps)).toMatchObject({ ok: false });
  });

  it("reads every page of the list", async () => {
    const iam = fakeIam();
    for (let i = 0; i < 130; i++) await createShareAccount(PROJECT, TENANT, CONN, iam.deps);
    const listed = await listShareAccounts(PROJECT, iam.deps);
    expect(listed.ok && listed.accounts.length).toBe(130);
    expect(iam.calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("refuses a redirect and any host but IAM's", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
    expect(await deleteShareAccount(PROJECT, "1234", { transport, appToken: async () => "t", log: () => {} })).toMatchObject({ ok: false, code: "redirect_refused" });
  });
});

describe("short lived tokens", () => {
  const sa = { email: `ygc-aaaaaaaaaaaaaaaaaaaa@${PROJECT}.iam.gserviceaccount.com`, createdAt: "2026-11-01T00:00:00.000Z" };

  it("mints a 300 second token with only the connector's scope, through the wildcard path, and keeps it in memory", async () => {
    const iam = fakeIam();
    const t = await shareAccessToken(sa, SCOPE, iam.deps);
    expect(t).toMatchObject({ ok: true, token: expect.stringMatching(/^made-up-minted-/) });
    const call = iam.calls[0]!;
    expect(call.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa.email)}:generateAccessToken`);
    expect(call.body).toEqual({ scope: [SCOPE], lifetime: "300s" });
    const again = await shareAccessToken(sa, SCOPE, iam.deps);
    expect(again).toEqual(t);
    expect(iam.calls).toHaveLength(1);
    // Within a minute of running out, a new one is minted; a forgotten address mints again too.
    await shareAccessToken(sa, SCOPE, { ...iam.deps, now: new Date(NOW.getTime() + 250_000) });
    expect(iam.calls).toHaveLength(2);
    forgetShareTokens(sa.email);
    await shareAccessToken(sa, SCOPE, iam.deps);
    expect(iam.calls).toHaveLength(3);
  });

  it("retries with backoff while IAM can't see a young account yet", async () => {
    const young = { ...sa, createdAt: new Date(NOW.getTime() - 30_000).toISOString() };
    const iam = fakeIam({ invisibleFor: 2 });
    expect(await shareAccessToken(young, SCOPE, iam.deps)).toMatchObject({ ok: true });
    expect(iam.sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([MINT_BACKOFF_MS[0], MINT_BACKOFF_MS[1]]);
    __resetShareTokens();
    const never = fakeIam({ invisibleFor: 99 });
    expect(await shareAccessToken(young, SCOPE, never.deps)).toMatchObject({ ok: false, code: "share_pending" });
    expect(never.calls).toHaveLength(MINT_BACKOFF_MS.length + 1);
  });

  it("doesn't retry an old account IAM refuses, and refuses an address YouGrow didn't make", async () => {
    const iam = fakeIam({ invisibleFor: 1 });
    expect(await shareAccessToken(sa, SCOPE, iam.deps)).toMatchObject({ ok: false, code: "share_unconfigured" });
    expect(iam.sleep).not.toHaveBeenCalled();
    const other = fakeIam();
    expect(await shareAccessToken({ ...sa, email: "someone@example.com" }, SCOPE, other.deps)).toMatchObject({ ok: false, code: "share_unconfigured" });
    expect(other.calls).toHaveLength(0);
  });
});
