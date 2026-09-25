import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { productUserDocId } from "@/lib/connect/profile";
import { deleteUser, patchUser, recordUserEvent } from "@/lib/connect/v2/users";
import type { ProductConnection } from "@/lib/types/productConnection";
import { enrolmentDocId } from "./enrol";
import { CONNECTION_ID, T0, publishOnboarding, seedWorld, system } from "./testing/fixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600_000;

beforeEach(() => {
  process.env.LIFECYCLE_ENABLED = "true";
});
afterEach(() => {
  delete process.env.LIFECYCLE_ENABLED;
});

async function setup(testUserIds = ["dana", "eli"]) {
  const db = new FakeFirestore();
  seedWorld(db);
  const { journey } = await publishOnboarding(db, { mode: "test", testUserIds });
  const connection = (await forTenant(system, db).productConnections.getById(CONNECTION_ID)) as ProductConnection;
  /** The product's sign-up write: the user's state, with signedUpAt. */
  const signup = (userId: string, at = T0, conn = connection) =>
    patchUser(system, conn, userId, { email: `${userId}@customer.test`, signedUpAt: iso(at) }, { db, nowMs: T0 + 60_000 });
  const enrolment = (userId: string) =>
    forTenant(system, db).lifecycleEnrolments.getById(enrolmentDocId(journey.id, productUserDocId(CONNECTION_ID, userId)));
  return { db, journey, connection, signup, enrolment };
}

describe("enrolment from the product's state writes", () => {
  it("a write with signedUpAt enrols the user, anchored at sign-up", async () => {
    const s = await setup();
    await s.signup("dana");
    const e = await s.enrolment("dana");
    expect(e).toMatchObject({
      status: "active",
      source: "trigger",
      mode: "test",
      anchorAt: iso(T0),
      externalUserId: "dana",
      cursor: { nodeId: "wait_welcome" },
      nextRunAt: iso(T0 + 60_000),
    });
  });

  it("a retried or repeated sign-up write never enrols twice", async () => {
    const s = await setup();
    await s.signup("dana");
    await s.signup("dana");
    await s.signup("dana", T0 + 1000);
    const all = await forTenant(system, s.db).lifecycleEnrolments.find();
    expect(all).toHaveLength(1);
  });

  it("a sign-up older than the trigger's window does not enrol (e.g. importing past users)", async () => {
    const s = await setup();
    await s.signup("dana", T0 - 73 * HOUR);
    expect(await s.enrolment("dana")).toBeNull();
  });

  it("other writes and milestones don't enrol, and nothing enrols while lifecycle is off", async () => {
    const s = await setup();
    await patchUser(system, s.connection, "dana", { email: "dana@customer.test" }, { db: s.db, nowMs: T0 });
    await recordUserEvent(system, s.connection, "dana", { event: "report.viewed" }, { db: s.db, nowMs: T0 });
    expect(await s.enrolment("dana")).toBeNull();
    delete process.env.LIFECYCLE_ENABLED;
    await s.signup("eli");
    expect(await s.enrolment("eli")).toBeNull();
  });

  it("a paused connection enrols no one", async () => {
    const s = await setup();
    await s.signup("eli", T0, { ...s.connection, status: "paused" as const });
    expect(await s.enrolment("eli")).toBeNull();
  });

  it("DELETE erases the user's enrolments along with their events", async () => {
    const s = await setup();
    await s.signup("dana");
    expect(await s.enrolment("dana")).not.toBeNull();
    await deleteUser(system, s.connection, "dana", { db: s.db, nowMs: T0 + 1000 });
    expect(await s.enrolment("dana")).toBeNull();
  });
});
