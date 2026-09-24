import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { ProductConnection } from "@/lib/types/productConnection";
import { ingestBatch } from "@/lib/connect/ingest";
import { productUserDocId } from "@/lib/connect/profile";
import { inviteEmailHash } from "./ids";
import { forgetNoInvites, inviteCodeOf, resetInviteMemo } from "./attribution";
import { ctx, seedConnection } from "./testing/fixtures";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const INVITED_AT = "2026-09-24T09:00:00.000Z";
const CODE_2 = "Q29kZUZvclNlY29uZDAxMjM";

function world() {
  const db = new FakeFirestore();
  seedConnection(db);
  seedConnection(db, "pcn_other", { name: "Other app" });
  const invite = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
    db.seed("invites", id, {
      tenantId: "ten_A",
      campaignId: "beta",
      waveId: "wav_1",
      signupId: `sig_${id}`,
      connectionId: "pcn_prod",
      emailHash: inviteEmailHash("ten_A", email),
      code,
      status: "invited",
      invited: true,
      invitedAt: INVITED_AT,
      clicked: false,
      clickCount: 0,
      signedUp: false,
      activated: false,
      ...over,
    });
  invite("inv_1", "amara@example.test", "Q29kZUZvckZpcnN0MDAxMjM");
  invite("inv_2", "ben@example.test", CODE_2);
  invite("inv_3", "chloe@example.test", "Q29kZUZvclRoaXJkMDAxMjM");
  const connection = { id: "pcn_prod", ...db.raw("product_connections", "pcn_prod") } as unknown as ProductConnection;
  return { db, connection };
}

const identify = (userId: string, email: string, ts = "2026-09-24T11:00:00.000Z") => ({
  type: "identify",
  messageId: `id-${userId}-${ts}`,
  userId,
  timestamp: ts,
  traits: { email },
});
const track = (userId: string, event: string, properties: Record<string, unknown> = {}, ts = "2026-09-24T11:05:00.000Z") => ({
  type: "track",
  messageId: `tr-${userId}-${event}-${ts}`,
  userId,
  event,
  timestamp: ts,
  properties,
});

beforeEach(() => {
  vi.stubEnv("INVITES_ENABLED", "true");
  resetInviteMemo();
});
afterEach(() => vi.unstubAllEnvs());

describe("invite attribution on ingest", () => {
  it("reads the code from a trait or from user.signed_up, and ignores anything malformed", () => {
    expect(inviteCodeOf({ type: "identify", traits: { yg_invite: CODE_2 } } as never)).toBe(CODE_2);
    expect(inviteCodeOf({ type: "track", event: "user.signed_up", properties: { yg_invite: CODE_2 } } as never)).toBe(CODE_2);
    expect(inviteCodeOf({ type: "track", event: "other", properties: { yg_invite: CODE_2 } } as never)).toBeNull();
    expect(inviteCodeOf({ type: "identify", traits: { yg_invite: "x y" } } as never)).toBeNull();
  });

  it("counts new users by email or by code, and activation when it happens later", async () => {
    const { db, connection } = world();
    await ingestBatch(
      ctx,
      connection,
      [identify("u1", "Amara@Example.test"), track("u2", "user.signed_up", { yg_invite: CODE_2 })],
      { db, nowMs: NOW },
    );
    expect(db.raw("invites", "inv_1")).toMatchObject({
      signedUp: true,
      matchedBy: "email",
      productUserId: productUserDocId("pcn_prod", "u1"),
      activated: false,
    });
    expect(db.raw("invites", "inv_2")).toMatchObject({ signedUp: true, matchedBy: "code" });

    await ingestBatch(ctx, connection, [track("u1", "onboarding.completed", {}, "2026-09-24T11:30:00.000Z")], { db, nowMs: NOW });
    expect(db.raw("invites", "inv_1")).toMatchObject({ activated: true, activatedAt: "2026-09-24T11:30:00.000Z" });
  });

  it("skips a product with no invites for a minute, until a wave creates some", async () => {
    const db = new FakeFirestore();
    seedConnection(db);
    const connection = { id: "pcn_prod", ...db.raw("product_connections", "pcn_prod") } as unknown as ProductConnection;
    await ingestBatch(ctx, connection, [identify("u1", "amara@example.test")], { db, nowMs: NOW });
    db.seed("invites", "inv_1", {
      tenantId: "ten_A",
      campaignId: "beta",
      waveId: "wav_1",
      signupId: "sig_1",
      connectionId: "pcn_prod",
      emailHash: inviteEmailHash("ten_A", "amara@example.test"),
      code: "Q29kZUZvckZpcnN0MDAxMjM",
      status: "invited",
      invited: true,
      invitedAt: INVITED_AT,
      signedUp: false,
      activated: false,
    });
    const again = (ts: string) => ingestBatch(ctx, connection, [identify("u1", "amara@example.test", ts)], { db, nowMs: NOW + 1000 });
    await again("2026-09-24T11:10:00.000Z");
    expect(db.raw("invites", "inv_1")).toMatchObject({ signedUp: false });
    forgetNoInvites("ten_A", "pcn_prod");
    await again("2026-09-24T11:20:00.000Z");
    expect(db.raw("invites", "inv_1")).toMatchObject({ signedUp: true, matchedBy: "email" });
  });

  it("someone who already used the product doesn't count as an invite sign-up", async () => {
    const { db, connection } = world();
    await ingestBatch(ctx, connection, [identify("u3", "chloe@example.test", "2026-09-01T10:00:00.000Z")], { db, nowMs: NOW });
    await ingestBatch(ctx, connection, [identify("u3", "chloe@example.test", "2026-09-24T11:00:00.000Z")], { db, nowMs: NOW });
    expect(db.raw("invites", "inv_3")).toMatchObject({ signedUp: false });
  });

  it("a code from another product's connection is ignored, and nothing runs while invites are off", async () => {
    const { db } = world();
    const other = { id: "pcn_other", ...db.raw("product_connections", "pcn_other") } as unknown as ProductConnection;
    await ingestBatch(ctx, other, [track("u9", "user.signed_up", { yg_invite: CODE_2 })], { db, nowMs: NOW });
    expect(db.raw("invites", "inv_2")).toMatchObject({ signedUp: false });

    vi.stubEnv("INVITES_ENABLED", "false");
    const second = world();
    await ingestBatch(ctx, second.connection, [identify("u1", "amara@example.test")], { db: second.db, nowMs: NOW });
    expect(second.db.raw("invites", "inv_1")).toMatchObject({ signedUp: false });
  });
});
