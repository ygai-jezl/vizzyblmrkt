import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { ProductUser } from "@/lib/types/productUser";
import { enrolmentDocId, enrolOnSignup } from "./enrol";
import { updateLifecycleDelivery } from "./service";
import { CONNECTION_ID, T0, ctx, publishOnboarding, seedUser, seedWorld, system } from "./testing/fixtures";

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const connection = { id: CONNECTION_ID, status: "active" as const };

async function setup(mode: "live" | "test" = "live", signedUpAt = iso(T0)) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex", { signedUpAt });
  const { journey } = await publishOnboarding(db, { mode, testUserIds: [] });
  const enrolment = () => forTenant(system, db).lifecycleEnrolments.getById(enrolmentDocId(journey.id, user.id));
  return { db, user, journey, enrolment };
}

describe("sign-up enrolment on every write (API v2)", () => {
  it("enrols a user whose signedUpAt is inside the journey's window, anchored at sign-up", async () => {
    const { db, user, enrolment } = await setup();
    expect(await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + HOUR })).toEqual({ enrolled: 1 });
    expect(await enrolment()).toMatchObject({ status: "active", anchorAt: iso(T0), source: "trigger" });
  });

  it("is idempotent: a later write doesn't enrol twice", async () => {
    const { db, user } = await setup();
    await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + HOUR });
    expect(await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + 2 * HOUR })).toEqual({ enrolled: 0 });
  });

  it("doesn't enrol once signedUpAt is outside the window (72 hours by default)", async () => {
    const { db, user, enrolment } = await setup();
    expect(await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + 73 * HOUR })).toEqual({ enrolled: 0 });
    expect(await enrolment()).toBeNull();
  });

  it("picks up people inside the window when a test-mode journey goes live", async () => {
    const { db, user, journey, enrolment } = await setup("test");
    expect(await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + HOUR })).toEqual({ enrolled: 0 }); // not a test recipient
    const live = await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "live", testRecipients: { userIds: [], emails: [] } }, { db, nowMs: T0 + 2 * HOUR });
    expect(live.ok).toBe(true);
    expect(await enrolOnSignup(system, connection, [user], { db, nowMs: T0 + 3 * HOUR })).toEqual({ enrolled: 1 });
    expect(await enrolment()).toMatchObject({ status: "active" });
  });

  it("skips people who are excluded or opted out in the product, and users with no sign-up time", async () => {
    const { db, user } = await setup();
    const excluded = { ...user, excluded: { reason: "staff", at: iso(T0) } } as ProductUser;
    const optedOut = { ...user, subscribed: false } as ProductUser;
    const noSignup = { ...user, signedUpAt: null } as ProductUser;
    expect(await enrolOnSignup(system, connection, [excluded, optedOut, noSignup], { db, nowMs: T0 + HOUR })).toEqual({ enrolled: 0 });
  });
});
