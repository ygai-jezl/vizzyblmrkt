import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { ingestBatch } from "@/lib/connect/ingest";
import { productUserDocId } from "@/lib/connect/profile";
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
  const signup = (userId: string, messageId: string, at = T0) => [
    { type: "identify", messageId: `${messageId}_id`, userId, timestamp: iso(at), traits: { email: `${userId}@customer.test` } },
    { type: "track", messageId, userId, timestamp: iso(at), event: "user.signed_up" },
  ];
  const ingest = (batch: unknown[], nowMs = T0 + 60_000) => ingestBatch(system, connection, batch, { db, nowMs });
  const enrolment = (userId: string) =>
    forTenant(system, db).lifecycleEnrolments.getById(enrolmentDocId(journey.id, productUserDocId(CONNECTION_ID, userId)));
  return { db, journey, connection, signup, ingest, enrolment };
}

describe("enrolment from ingested events", () => {
  it("a user.signed_up event enrols the user, anchored at the event's own time", async () => {
    const s = await setup();
    await s.ingest(s.signup("dana", "m1"));
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

  it("a replayed or repeated sign-up never enrols twice", async () => {
    const s = await setup();
    await s.ingest(s.signup("dana", "m1"));
    await s.ingest(s.signup("dana", "m1")); // replay: duplicate messages
    await s.ingest(s.signup("dana", "m2")); // a second sign-up event
    const all = await forTenant(system, s.db).lifecycleEnrolments.find();
    expect(all).toHaveLength(1);
  });

  it("an event older than the trigger's max age does not enrol (e.g. a backfill replay)", async () => {
    const s = await setup();
    await s.ingest(s.signup("dana", "m_old", T0 - 73 * HOUR));
    expect(await s.enrolment("dana")).toBeNull();
  });

  it("other events don't enrol, and nothing enrols while lifecycle is off", async () => {
    const s = await setup();
    await s.ingest([{ type: "track", messageId: "x1", userId: "dana", timestamp: iso(T0), event: "report.viewed" }]);
    expect(await s.enrolment("dana")).toBeNull();
    delete process.env.LIFECYCLE_ENABLED;
    await s.ingest(s.signup("eli", "m3"));
    expect(await s.enrolment("eli")).toBeNull();
  });

  it("a paused connection enrols no one", async () => {
    const s = await setup();
    await s.ingest(s.signup("dana", "m1"), T0 + 60_000);
    const paused = { ...s.connection, status: "paused" as const };
    await ingestBatch(system, paused, s.signup("eli", "m4"), { db: s.db, nowMs: T0 + 60_000 });
    expect(await s.enrolment("eli")).toBeNull();
  });

  it("user.deleted erases the user's enrolments along with their events", async () => {
    const s = await setup();
    await s.ingest(s.signup("dana", "m1"));
    expect(await s.enrolment("dana")).not.toBeNull();
    await s.ingest([{ type: "track", messageId: "del1", userId: "dana", timestamp: iso(T0 + 1000), event: "user.deleted" }]);
    expect(await s.enrolment("dana")).toBeNull();
  });
});
