import { describe, it, expect, beforeEach } from "vitest";
import {
  signCanvasContext,
  verifyCanvasContext,
  tenantContextFromCanvasToken,
  isCanvasAuthConfigured,
  mintCanvasContextOrNull,
} from "./auth";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = {
  tenantId: "ten_acme",
  region: "us",
  userId: "user_123",
  role: "admin",
  source: "idtoken",
};

beforeEach(() => {
  process.env.CANVAS_CONTEXT_SIGNING_KEY = "test-signing-key-abc";
  delete process.env.CANVAS_ALLOW_INSECURE_LOCAL;
});

describe("canvas capability token", () => {
  it("round-trips a verified context through sign → verify", () => {
    const token = signCanvasContext(ctx);
    const res = verifyCanvasContext(token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.tenantId).toBe("ten_acme");
    expect(res.claims.region).toBe("us");
    expect(res.claims.userId).toBe("user_123");
    expect(res.claims.role).toBe("admin");
    expect(res.claims.exp).toBeGreaterThan(res.claims.iat);
  });

  it("produces a BRACE-FREE token (survives the [ctx:{...}] envelope regex)", () => {
    const token = signCanvasContext(ctx);
    expect(token).not.toContain("{");
    expect(token).not.toContain("}");
    expect(token.split(".")).toHaveLength(2);
  });

  it("rejects a tampered payload", () => {
    const token = signCanvasContext(ctx);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...ctx, tenantId: "ten_evil", exp: 9999999999, iat: 1, jti: "x" }),
    ).toString("base64url");
    const res = verifyCanvasContext(`${forged}.${sig}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bad_signature");
  });

  it("rejects a tampered signature", () => {
    const token = signCanvasContext(ctx);
    const [payload] = token.split(".");
    const res = verifyCanvasContext(`${payload}.deadbeef`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bad_signature");
  });

  it("rejects an expired token", () => {
    const past = Date.now() - 60 * 60 * 1000;
    const token = signCanvasContext(ctx, { now: past, ttlSeconds: 60 });
    const res = verifyCanvasContext(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("expired");
  });

  it("rejects a malformed token", () => {
    expect(verifyCanvasContext("not-a-token").ok).toBe(false);
    expect(verifyCanvasContext("").ok).toBe(false);
  });

  it("a token signed with a different key fails", () => {
    const token = signCanvasContext(ctx);
    process.env.CANVAS_CONTEXT_SIGNING_KEY = "a-completely-different-key";
    const res = verifyCanvasContext(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bad_signature");
  });

  it("reconstructs a tenant context with source 'agent'", () => {
    const token = signCanvasContext(ctx);
    const res = verifyCanvasContext(token);
    if (!res.ok) throw new Error("expected ok");
    const reconstructed = tenantContextFromCanvasToken(res.claims);
    expect(reconstructed).toEqual({
      tenantId: "ten_acme",
      region: "us",
      userId: "user_123",
      role: "admin",
      source: "agent",
    });
  });

  it("is unconfigured (and mints null) when no key is set", () => {
    delete process.env.CANVAS_CONTEXT_SIGNING_KEY;
    expect(isCanvasAuthConfigured()).toBe(false);
    expect(mintCanvasContextOrNull(ctx)).toBeNull();
    expect(verifyCanvasContext("x.y").ok).toBe(false);
  });

  it("falls back to the insecure-local key only outside production", () => {
    delete process.env.CANVAS_CONTEXT_SIGNING_KEY;
    process.env.CANVAS_ALLOW_INSECURE_LOCAL = "1";
    expect(isCanvasAuthConfigured()).toBe(true);
    const token = signCanvasContext(ctx);
    expect(verifyCanvasContext(token).ok).toBe(true);
  });
});
