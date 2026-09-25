import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { DeliveryMode, LifecycleSettings } from "@/lib/types/lifecycle";
import { enrolmentDocId, enrolUser } from "./enrol";
import { sweepGoLive } from "./goLive";
import { updateLifecycleDelivery } from "./service";
import { T0, ctx, publishOnboarding, seedUser, seedWorld, system } from "./testing/fixtures";

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_GO_LIVE_SWEEP = "true";
});
afterEach(() => {
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_GO_LIVE_SWEEP;
});

/** A sign-up an hour after T0, seen five minutes later. */
function signUp(db: FakeFirestore, id: string, atMs = T0, over: Parameters<typeof seedUser>[2] = {}) {
  return seedUser(db, id, { signedUpAt: iso(atMs), lastSeenAt: iso(atMs + 5 * 60_000), ...over });
}

async function setup(mode: DeliveryMode = "test", settings?: Partial<LifecycleSettings>) {
  const db = new FakeFirestore();
  seedWorld(db);
  const recent = signUp(db, "recent");
  const old = signUp(db, "old", T0 - 100 * HOUR); // outside the 72-hour window
  const { journey, version } = await publishOnboarding(db, { mode, testUserIds: [], ...(settings ? { settings } : {}) });
  const repo = forTenant(system, db);
  const enrolled = async (u: { id: string }) => Boolean(await repo.lifecycleEnrolments.getById(enrolmentDocId(journey.id, u.id)));
  const sweep = (nowMs: number, pageSize?: number) => sweepGoLive(system, { db, now: () => nowMs, deadlineMs: nowMs + 60_000, pageSize });
  const setMode = (deliveryMode: DeliveryMode, nowMs: number) =>
    updateLifecycleDelivery(ctx, journey.id, { deliveryMode, testRecipients: { userIds: [], emails: [] } }, { db, nowMs });
  const marker = async () => (await repo.lifecycleJourneys.getById(journey.id))?.goLiveSweep ?? null;
  return { db, recent, old, journey, version, repo, enrolled, sweep, setMode, marker };
}

describe("the go-live sweep (LIFECYCLE_GO_LIVE_SWEEP)", () => {
  it("enrols the window's sign-ups once a test journey goes live, and only once", async () => {
    const w = await setup("test");
    expect(await w.sweep(T0 + HOUR)).toEqual({ journeys: 0, enrolled: 0 }); // test mode: nothing to do
    expect(await w.enrolled(w.recent)).toBe(false);
    expect((await w.setMode("live", T0 + 2 * HOUR)).ok).toBe(true);
    expect(await w.sweep(T0 + 3 * HOUR)).toEqual({ journeys: 1, enrolled: 1 });
    expect(await w.enrolled(w.recent)).toBe(true);
    expect(await w.enrolled(w.old)).toBe(false);
    expect(await w.repo.lifecycleEnrolments.getById(enrolmentDocId(w.journey.id, w.recent.id))).toMatchObject({ anchorAt: iso(T0), source: "trigger" });
    expect(await w.marker()).toMatchObject({ status: "done", enrolled: 1 });
    expect(await w.sweep(T0 + 4 * HOUR)).toEqual({ journeys: 0, enrolled: 0 });
  });

  it("treats the environment's ceiling lifting as going live", async () => {
    process.env.LIFECYCLE_MODE_CEILING = "test";
    const w = await setup("live");
    expect(await w.sweep(T0 + HOUR)).toEqual({ journeys: 0, enrolled: 0 });
    process.env.LIFECYCLE_MODE_CEILING = "live";
    expect(await w.sweep(T0 + 2 * HOUR)).toEqual({ journeys: 1, enrolled: 1 });
    expect(await w.enrolled(w.recent)).toBe(true);
  });

  it("skips excluded, unsubscribed and already-enrolled people", async () => {
    const w = await setup("test");
    const staff = signUp(w.db, "staff", T0, { excluded: { reason: "staff", at: iso(T0) } });
    const optedOut = signUp(w.db, "opted_out", T0, { subscribed: false });
    await w.setMode("live", T0 + HOUR);
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    expect((await enrolUser(system, { journey, version: w.version, user: w.recent, source: "manual", anchorAt: iso(T0) }, { db: w.db, nowMs: T0 + HOUR })).outcome).toBe("enrolled");
    expect(await w.sweep(T0 + 2 * HOUR)).toEqual({ journeys: 1, enrolled: 0 });
    expect(await w.enrolled(staff)).toBe(false);
    expect(await w.enrolled(optedOut)).toBe(false);
  });

  it("pages through the window, and resumes from its cursor", async () => {
    const w = await setup("test");
    const more = [1, 2, 3, 4].map((i) => signUp(w.db, `u${i}`, T0 + i * 60_000));
    await w.setMode("live", T0 + HOUR);
    expect(await w.sweep(T0 + 2 * HOUR, 2)).toEqual({ journeys: 1, enrolled: 5 });
    for (const u of more) expect(await w.enrolled(u)).toBe(true);

    // A sweep cut short resumes where it stopped: only people seen at or before the cursor.
    const late = signUp(w.db, "late", T0 + 30 * 60_000);
    await w.repo.lifecycleJourneys.update(w.journey.id, {
      goLiveSweep: { status: "running", cursor: iso(T0 + 20 * 60_000), enrolled: 5, updatedAt: iso(T0 + 2 * HOUR) },
    });
    expect(await w.sweep(T0 + 3 * HOUR, 2)).toEqual({ journeys: 1, enrolled: 0 });
    expect(await w.enrolled(late)).toBe(false); // seen after the cursor: a new write enrols them instead
  });

  it("clears the marker below live, and sweeps again on the next go-live", async () => {
    const w = await setup("live");
    expect(await w.sweep(T0 + HOUR)).toEqual({ journeys: 1, enrolled: 1 });
    await w.setMode("test", T0 + 2 * HOUR);
    await w.sweep(T0 + 3 * HOUR);
    expect(await w.marker()).toBeNull();
    const next = signUp(w.db, "next", T0 + 4 * HOUR);
    await w.setMode("live", T0 + 5 * HOUR);
    expect(await w.sweep(T0 + 6 * HOUR)).toEqual({ journeys: 1, enrolled: 1 });
    expect(await w.enrolled(next)).toBe(true);
  });

  it("leaves journeys started by other events alone", async () => {
    const w = await setup("live", { trigger: { event: "report.exported", maxEventAgeHours: 72 } });
    expect(await w.sweep(T0 + HOUR)).toEqual({ journeys: 0, enrolled: 0 });
    expect(await w.enrolled(w.recent)).toBe(false);
    expect(await w.marker()).toMatchObject({ status: "done" });
  });
});
