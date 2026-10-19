import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import {
  mintSession,
  msSinceSessionMint,
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
});
