import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { ProductConnection } from "@/lib/types/productConnection";
import { patchUser, recordUserEvent } from "@/lib/connect/v2/users";
import type { UserPatch } from "@/lib/connect/v2/contract";
import { productUserDocId } from "@/lib/connect/profile";
import { inviteEmailHash } from "./ids";
import { forgetNoInvites, inviteCodeFromTraits, resetInviteMemo } from "./attribution";
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

const write = (db: FakeFirestore, connection: ProductConnection, userId: string, patch: UserPatch, nowMs = NOW) =>
  patchUser(ctx, connection, userId, patch, { db, nowMs });

beforeEach(() => {
  vi.stubEnv("INVITES_ENABLED", "true");
  resetInviteMemo();
});
afterEach(() => vi.unstubAllEnvs());

describe("invite attribution on API v2 writes", () => {
  it("reads a well-formed code from the yg_invite trait, and ignores anything else", () => {
    expect(inviteCodeFromTraits({ yg_invite: CODE_2 })).toBe(CODE_2);
    expect(inviteCodeFromTraits({ yg_invite: "x y" })).toBeNull();
    expect(inviteCodeFromTraits({ plan: "pro" })).toBeNull();
    expect(inviteCodeFromTraits(undefined)).toBeNull();
  });

  it("counts new users by email or by code, and activation when it happens later", async () => {
    const { db, connection } = world();
    await write(db, connection, "u1", { email: "Amara@Example.test", signedUpAt: "2026-09-24T11:00:00.000Z" });
    await write(db, connection, "u2", { traits: { yg_invite: CODE_2 }, signedUpAt: "2026-09-24T11:05:00.000Z" });
    expect(db.raw("invites", "inv_1")).toMatchObject({
      signedUp: true,
      signedUpAt: "2026-09-24T11:00:00.000Z",
      matchedBy: "email",
      productUserId: productUserDocId("pcn_prod", "u1"),
      activated: false,
    });
    expect(db.raw("invites", "inv_2")).toMatchObject({ signedUp: true, matchedBy: "code" });

    await recordUserEvent(ctx, connection, "u1", { event: "onboarding.completed", occurredAt: "2026-09-24T11:30:00.000Z" }, { db, nowMs: NOW });
    expect(db.raw("invites", "inv_1")).toMatchObject({ activated: true, activatedAt: "2026-09-24T11:30:00.000Z" });
  });

  it("skips a product with no invites for a minute, until a wave creates some", async () => {
    const db = new FakeFirestore();
    seedConnection(db);
    const connection = { id: "pcn_prod", ...db.raw("product_connections", "pcn_prod") } as unknown as ProductConnection;
    await write(db, connection, "u1", { email: "amara@example.test" });
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
    const again = () => write(db, connection, "u1", { firstName: "Amara" }, NOW + 1000);
    await again();
    expect(db.raw("invites", "inv_1")).toMatchObject({ signedUp: false });
    forgetNoInvites("ten_A", "pcn_prod");
    await again();
    expect(db.raw("invites", "inv_1")).toMatchObject({ signedUp: true, matchedBy: "email" });
  });

  it("someone whose account predates the invite doesn't count as an invite sign-up", async () => {
    const { db, connection } = world();
    await write(db, connection, "u3", { email: "chloe@example.test", signedUpAt: "2026-09-01T10:00:00.000Z" });
    await write(db, connection, "u3", { firstName: "Chloe" });
    expect(db.raw("invites", "inv_3")).toMatchObject({ signedUp: false });
  });

  it("a code from another product's connection is ignored, and nothing runs while invites are off", async () => {
    const { db } = world();
    const other = { id: "pcn_other", ...db.raw("product_connections", "pcn_other") } as unknown as ProductConnection;
    await write(db, other, "u9", { traits: { yg_invite: CODE_2 } });
    expect(db.raw("invites", "inv_2")).toMatchObject({ signedUp: false });

    vi.stubEnv("INVITES_ENABLED", "false");
    const second = world();
    await write(second.db, second.connection, "u1", { email: "amara@example.test" });
    expect(second.db.raw("invites", "inv_1")).toMatchObject({ signedUp: false });
  });
});
