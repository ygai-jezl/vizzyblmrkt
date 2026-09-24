import { afterEach, describe, expect, it, vi } from "vitest";
import { inviteLinkUrl, isInviteLinksConfigured, signInviteToken, verifyInviteToken } from "./token";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const DAY = 86_400_000;
const mint = (over: Partial<{ tenantId: string; inviteId: string; expiresAtMs: number }> = {}) =>
  signInviteToken({ tenantId: "ten_A", inviteId: "inv_abc123", expiresAtMs: NOW + 30 * DAY, ...over });

afterEach(() => vi.unstubAllEnvs());

describe("invite link token", () => {
  it("round-trips and is URL-safe (no braces, slashes or padding)", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    const token = mint();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const r = verifyInviteToken(token, NOW);
    expect(r).toMatchObject({ ok: true, expired: false, claims: { v: 1, t: "ten_A", i: "inv_abc123" } });
    expect(inviteLinkUrl("https://waitlist.example.com/", token)).toBe(`https://waitlist.example.com/invite/${token}`);
  });

  it("rejects a tampered payload or signature", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    const token = mint();
    const [payload, sig] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), i: "inv_someone_else" }),
    ).toString("base64url");
    expect(verifyInviteToken(`${other}.${sig}`, NOW)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyInviteToken(`${payload}.${sig!.slice(0, -2)}xx`, NOW)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyInviteToken("not-a-token", NOW)).toEqual({ ok: false, error: "malformed" });
    expect(verifyInviteToken(".", NOW)).toEqual({ ok: false, error: "malformed" });
  });

  it("reports expiry but still verifies the signature", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    const token = mint({ expiresAtMs: NOW - 1000 });
    expect(verifyInviteToken(token, NOW)).toMatchObject({ ok: true, expired: true });
  });

  it("a link signed with another key fails", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    const token = mint();
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-two");
    expect(verifyInviteToken(token, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("keeps old links working through a rotation while the old key is PREVIOUS", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    const old = mint();
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-two");
    vi.stubEnv("INVITE_LINK_SIGNING_KEY_PREVIOUS", "k-one");
    expect(verifyInviteToken(old, NOW)).toMatchObject({ ok: true });
    expect(verifyInviteToken(mint(), NOW)).toMatchObject({ ok: true });
    vi.stubEnv("INVITE_LINK_SIGNING_KEY_PREVIOUS", "");
    expect(verifyInviteToken(old, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("refuses unsafe claim values even with a valid signature", () => {
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "k-one");
    expect(verifyInviteToken(mint({ inviteId: "../../etc" }), NOW)).toEqual({ ok: false, error: "invalid_claims" });
  });

  it("is unconfigured in production without a key", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INVITE_LINK_SIGNING_KEY", "");
    expect(isInviteLinksConfigured()).toBe(false);
    expect(() => mint()).toThrow("invite_links_unconfigured");
    expect(verifyInviteToken("a.b", NOW)).toEqual({ ok: false, error: "not_configured" });
  });
});
