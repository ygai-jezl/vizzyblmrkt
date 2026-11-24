import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import {
  mintSession,
  msSinceSessionMint,
  mustSignOut,
  safeNextPath,
  shouldInterceptApi,
  stampSessionMinted,
} from "./clientSession";

const ORIGIN = "https://app.example.com";

describe("shouldInterceptApi", () => {
  it("intercepts same-origin admin API calls (relative and absolute)", () => {
    expect(shouldInterceptApi("/api/admin/workspace/w/content-plans/p", ORIGIN)).toBe(true);
    expect(shouldInterceptApi(`${ORIGIN}/api/admin/email/broadcasts`, ORIGIN)).toBe(true);
  });

  it("never intercepts the mint endpoint itself (would recurse on a bad ID token)", () => {
    expect(shouldInterceptApi("/api/auth/session", ORIGIN)).toBe(false);
  });

  it("ignores non-API and cross-origin URLs", () => {
    expect(shouldInterceptApi("/admin/workspace/w/create/p", ORIGIN)).toBe(false);
    expect(shouldInterceptApi("https://api.example.com/api/admin/x", ORIGIN)).toBe(false);
    // Protocol-relative resolves cross-origin, not as a path.
    expect(shouldInterceptApi("//evil.example/api/admin/x", ORIGIN)).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(shouldInterceptApi("http://", ORIGIN)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("accepts internal absolute paths, with query strings", () => {
    expect(safeNextPath("/admin/workspace/w/create/p")).toBe("/admin/workspace/w/create/p");
    expect(safeNextPath("/admin/signups?page=2")).toBe("/admin/signups?page=2");
  });

  it("rejects external, protocol-relative, relative, and looping targets", () => {
    expect(safeNextPath("https://evil.example/phish")).toBeNull();
    expect(safeNextPath("//evil.example/phish")).toBeNull();
    expect(safeNextPath("admin/signups")).toBeNull();
    expect(safeNextPath("/login")).toBeNull();
    expect(safeNextPath("/login?next=/admin")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  it("rejects paths a browser reads as another origin: backslashes, tabs, newlines and other controls", () => {
    for (const raw of ["/\\evil.test/login", "/\\/evil.test", "/\t/evil.test", "/\n/evil.test", "/\r//evil.test", "/ /evil.test", "/admin\u0000x", "/admin/\\x"]) {
      expect(safeNextPath(raw), JSON.stringify(raw)).toBeNull();
    }
    // As they arrive in ?next=, decoded by URLSearchParams.
    for (const query of ["?next=/%5Cevil.test/login", "?next=/%09/evil.test", "?next=/%0A/evil.test"]) {
      expect(safeNextPath(new URLSearchParams(query).get("next")), query).toBeNull();
    }
  });
});

describe("mint stamp without a browser environment", () => {
  it("degrades to unknown age instead of throwing (node has no window)", () => {
    expect(() => stampSessionMinted()).not.toThrow();
    expect(msSinceSessionMint()).toBeNull();
  });
});

describe("mintSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  const user = { getIdToken: async () => "id-token" } as unknown as User;
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("tells a refused account apart from a workspace that isn't set up yet", async () => {
    respond(403, { error: "access_denied" });
    await expect(mintSession(user)).resolves.toBe("forbidden");
    respond(403, { error: "workspace_not_set_up", message: "..." });
    await expect(mintSession(user)).resolves.toBe("not_set_up");
  });

  it("reports anything else as an error, and ok on success", async () => {
    respond(401, { error: "invalid_id_token" });
    await expect(mintSession(user)).resolves.toBe("error");
    respond(200, { ok: true });
    await expect(mintSession(user)).resolves.toBe("ok");
  });

  it("tells an unconfirmed password account, and one that must use Google, apart from a refusal", async () => {
    respond(403, { error: "email_not_verified" });
    await expect(mintSession(user)).resolves.toBe("email_not_verified");
    respond(403, { error: "google_only" });
    await expect(mintSession(user)).resolves.toBe("google_only");
    respond(403, {});
    await expect(mintSession(user)).resolves.toBe("forbidden");
  });

  it("asks for a fresh sign in when the door removed the account, and only then", async () => {
    respond(409, { error: "sign_in_again" });
    await expect(mintSession(user)).resolves.toBe("sign_in_again");
    respond(409, { error: "conflict" });
    await expect(mintSession(user)).resolves.toBe("error");
    respond(500, { error: "sign_in_again" });
    await expect(mintSession(user)).resolves.toBe("error");
  });

  it("signs out after a renamed Google address was moved, without refreshing the revoked sign-in", async () => {
    const tokens: boolean[] = [];
    const renamed = {
      getIdToken: async (force?: boolean) => {
        tokens.push(force === true);
        return "id-token";
      },
    } as unknown as User;
    respond(409, { error: "address_updated" });
    await expect(mintSession(renamed)).resolves.toBe("address_updated");
    // Refreshing would fail: the move revoked this sign-in.
    expect(tokens).toEqual([false]);
    expect(mustSignOut("address_updated")).toBe(true);
    expect(mustSignOut("sign_in_again")).toBe(true);
    for (const r of ["ok", "forbidden", "not_set_up", "email_not_verified", "google_only", "error"] as const) {
      expect(mustSignOut(r), r).toBe(false);
    }
  });

  it("reads the door's answer after the first sign-in's refresh too", async () => {
    const tokens: boolean[] = [];
    const refreshing = {
      getIdToken: async (force?: boolean) => {
        tokens.push(force === true);
        return "id-token";
      },
    } as unknown as User;
    const answers = [
      new Response(JSON.stringify({ needsRefresh: true }), { status: 200 }),
      new Response(JSON.stringify({ error: "sign_in_again" }), { status: 409 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    await expect(mintSession(refreshing)).resolves.toBe("sign_in_again");
    expect(tokens).toEqual([false, true]);
  });
});
