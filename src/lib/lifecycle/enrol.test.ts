import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { productUserDocId } from "@/lib/connect/profile";
import { deleteUser, patchUser, recordUserEvent } from "@/lib/connect/v2/users";
import type { ProductConnection } from "@/lib/types/productConnection";
import { personIdForProductUser } from "@/lib/ontology/personRef";
import { enrolmentDocId, enrolUser, pastSignupWindow, signupWindowHours } from "./enrol";
import { CONNECTION_ID, T0, publishOnboarding, seedUser, seedWorld, system } from "./testing/fixtures";

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

describe("the sign-up window", () => {
  const version = (event: string, maxEventAgeHours: number) =>
    ({ version: { settings: { trigger: { event, maxEventAgeHours } } } }) as unknown as Parameters<typeof signupWindowHours>[0][number];

  it("is the longest among the sign-up journeys, 72 hours without one", () => {
    expect(signupWindowHours([])).toBe(72);
    expect(signupWindowHours([version("user.marketing_consent_granted", 500)])).toBe(72);
    expect(signupWindowHours([version("user.signed_up", 24), version("user.signed_up", 168), version("report.exported", 700)])).toBe(168);
  });

  it("counts from signedUpAt, else from when YouGrow first heard of them", () => {
    const at = new Date(T0).toISOString();
    expect(pastSignupWindow({ signedUpAt: at, firstSeenAt: at }, 72, T0 + 71 * 3600_000)).toBe(false);
    expect(pastSignupWindow({ signedUpAt: at, firstSeenAt: at }, 72, T0 + 73 * 3600_000)).toBe(true);
    expect(pastSignupWindow({ signedUpAt: null, firstSeenAt: at }, 72, T0 + 3600_000)).toBe(false);
    expect(pastSignupWindow({ signedUpAt: new Date(T0 - 10 * 86_400_000).toISOString(), firstSeenAt: at }, 72, T0)).toBe(true);
  });
});

describe("the person on an enrolment (ONTOLOGY_PERSON_IDS_ENABLED)", () => {
  async function world() {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey, version } = await publishOnboarding(db, { mode: "live" });
    const user = seedUser(db, "dana");
    const connection = (await forTenant(system, db).productConnections.getById(CONNECTION_ID)) as ProductConnection;
    const enrol = (over: Partial<Parameters<typeof enrolUser>[1]> = {}) =>
      enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0), ...over }, { db, nowMs: T0 });
    const stored = () => forTenant(system, db).lifecycleEnrolments.getById(enrolmentDocId(journey.id, user.id));
    return { db, user, connection, enrol, stored };
  }

  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("writes the person for a custom product, with no read of the connection it was handed", async () => {
    const w = await world();
    const before = w.db.collectionCalls("product_connections");
    expect((await w.enrol({ connection: w.connection })).outcome).toBe("enrolled");
    expect(w.db.collectionCalls("product_connections")).toBe(before);
    expect((await w.stored())?.personId).toBe(personIdForProductUser(system.tenantId, w.user, w.connection));
    expect((await w.stored())?.personId).toMatch(/^ct_/);
  });

  it("writes no person for a sandbox's user", async () => {
    const w = await world();
    await w.enrol({ connection: { ...w.connection, kind: "sandbox" } });
    expect((await w.stored())?.personId).toBeUndefined();
  });

  it("reads the connection once when the caller didn't pass it", async () => {
    const w = await world();
    const before = w.db.collectionCalls("product_connections");
    await w.enrol();
    expect(w.db.collectionCalls("product_connections")).toBe(before + 1);
    expect((await w.stored())?.personId).toBe(personIdForProductUser(system.tenantId, w.user, w.connection));
  });

  it("writes no person and reads nothing more while the switch is off, or the person links are", async () => {
    for (const [links, ids] of [["true", "false"], ["false", "true"]] as const) {
      vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", links);
      vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", ids);
      const w = await world();
      const before = w.db.collectionCalls("product_connections");
      await w.enrol();
      expect(w.db.collectionCalls("product_connections")).toBe(before);
      expect(await w.stored()).not.toHaveProperty("personId");
    }
  });

  it("writes the person on a product's sign-up write, from the connection it holds", async () => {
    process.env.LIFECYCLE_MODE_CEILING = "live";
    try {
      const db = new FakeFirestore();
      seedWorld(db);
      const { journey } = await publishOnboarding(db, { mode: "live" });
      const connection = (await forTenant(system, db).productConnections.getById(CONNECTION_ID)) as ProductConnection;
      await patchUser(system, connection, "erin", { email: "Erin@Customer.test", signedUpAt: iso(T0) }, { db, nowMs: T0 + 60_000 });
      const id = productUserDocId(CONNECTION_ID, "erin");
      const e = await forTenant(system, db).lifecycleEnrolments.getById(enrolmentDocId(journey.id, id));
      expect(e?.personId).toBe(personIdForProductUser(system.tenantId, { id, emailNormalized: "erin@customer.test" }, connection));
    } finally {
      delete process.env.LIFECYCLE_MODE_CEILING;
    }
  });
});
