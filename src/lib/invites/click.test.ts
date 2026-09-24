import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { handleInviteClick } from "./click";
import { signInviteToken } from "./token";
import { ctx, seedConnection } from "./testing/fixtures";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const tenantById = vi.fn(async (id: string) => (id === "ten_A" ? ({ id: "ten_A", region: "us" } as never) : null));
const open = vi.fn(async () => false);

function world(over: Record<string, unknown> = {}) {
  const db = new FakeFirestore();
  seedConnection(db);
  db.seed("invites", "inv_1", {
    tenantId: "ten_A",
    campaignId: "beta",
    waveId: "wav_1",
    signupId: "s1",
    connectionId: "pcn_prod",
    emailHash: "h",
    code: "Zm9vYmFyYmF6cXV4MTIzNA",
    status: "invited",
    invited: true,
    clicked: false,
    clickCount: 0,
    signedUp: false,
    activated: false,
    ...over,
  });
  return db;
}
const token = (expiresAtMs = NOW + 86_400_000) => signInviteToken({ tenantId: ctx.tenantId, inviteId: "inv_1", expiresAtMs });
const click = (db: FakeFirestore, t: string, method = "GET", rateLimited = open) =>
  handleInviteClick(t, { method, ip: "203.0.113.9" }, { db, now: NOW, rateLimited, tenantById });

beforeEach(() => vi.stubEnv("INVITE_LINK_SIGNING_KEY", "test-key"));
afterEach(() => vi.unstubAllEnvs());

describe("invite link clicks", () => {
  it("redirects to the saved sign-up URL with only the invite code, and records the first click", async () => {
    const db = world();
    const r = await click(db, token());
    expect(r).toEqual({ kind: "redirect", location: "https://app.fernlight.test/signup?yg_invite=Zm9vYmFyYmF6cXV4MTIzNA" });
    if (r.kind === "redirect") expect(r.location).not.toMatch(/@|ten_A|inv_1/);
    expect(db.raw("invites", "inv_1")).toMatchObject({ clicked: true, clickedAt: "2026-09-24T12:00:00.000Z", clickCount: 1 });
    await click(db, token());
    expect(db.raw("invites", "inv_1")).toMatchObject({ clickCount: 2, clickedAt: "2026-09-24T12:00:00.000Z" });
  });

  it("HEAD requests (link scanners) redirect but record nothing", async () => {
    const db = world();
    expect(await click(db, token(), "HEAD")).toMatchObject({ kind: "redirect" });
    expect(db.raw("invites", "inv_1")).toMatchObject({ clicked: false, clickCount: 0 });
  });

  it("refuses tampered tokens, unknown tenants and withdrawn invites", async () => {
    const db = world();
    expect(await click(db, `${token()}x`)).toMatchObject({ kind: "page", status: 404 });
    expect(await click(db, "garbage")).toMatchObject({ kind: "page", status: 404 });
    const cancelled = world({ status: "cancelled" });
    expect(await click(cancelled, token())).toMatchObject({ kind: "page", status: 410 });
  });

  it("an expired link shows a page with a plain link to sign up (no code)", async () => {
    const db = world();
    const r = await click(db, token(NOW - 1000));
    expect(r).toMatchObject({ kind: "page", status: 410, productUrl: "https://app.fernlight.test/signup" });
    expect(db.raw("invites", "inv_1")).toMatchObject({ clicked: false });
  });

  it("pauses when the product's sign-up link is no longer valid, and rate-limits by IP", async () => {
    const db = world();
    seedConnection(db, "pcn_prod", { signupUrl: "https://elsewhere.test/signup" });
    expect(await click(db, token())).toMatchObject({ kind: "page", status: 503 });
    expect(await click(world(), token(), "GET", vi.fn(async () => true))).toMatchObject({ kind: "page", status: 429 });
  });
});
