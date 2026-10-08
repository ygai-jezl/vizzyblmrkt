import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { DATE_PASSED_EVENT, type DateStart, type DeliveryMode, type LifecycleSettings } from "@/lib/types/lifecycle";
import type { ProductUser } from "@/lib/types/productUser";
import { checkJourneyDates, enrolByHand } from "./adminApi";
import { checkDatesNow, dateEntry, storedDateMs, sweepDateStarts } from "./dateStart";
import { enrolOnEvents } from "./enrol";
import { runLifecycleTick } from "./runner";
import { createLifecycleJourney, saveLifecycleDraft } from "./service";
import { CONNECTION_ID, STEPS, T0, TENANT_ID, ctx, publishOnboarding, seedUser, seedWorld, system } from "./testing/fixtures";

const DAY = 86_400_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** T0 is 07:00 UTC, the hour the daily check starts. */
const NOW = T0;

const fact = (id: string, kind?: string) => ({ id, label: "Last active", type: "date" as const, unit: null, description: "", source: "", ...(kind ? { kind } : {}) });
const CATALOG = { events: [], traits: [], onboardingSteps: STEPS, glossary: [], entityKinds: [], facts: [fact("last_active_at")] };
const START: DateStart = { fact: "last_active_at", days: 14, windowDays: 7, stopWhenDateMoves: true, reenterAfterDays: null };
const trigger = (date: Partial<DateStart> = {}): LifecycleSettings["trigger"] => ({ event: DATE_PASSED_EVENT, maxEventAgeHours: 72, date: { ...START, ...date } });

beforeEach(() => {
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_GO_LIVE_SWEEP = "true";
  process.env.CONNECT_DATE_FACTS = "true";
  process.env.LIFECYCLE_DATE_START = "true";
});
afterEach(() => {
  for (const k of ["LIFECYCLE_MODE_CEILING", "LIFECYCLE_GO_LIVE_SWEEP", "CONNECT_DATE_FACTS", "LIFECYCLE_DATE_START", "CONNECT_ENTITIES_ENABLED"]) delete process.env[k];
});

/** Someone last active `daysAgo` days before NOW. */
function quiet(db: FakeFirestore, id: string, daysAgo: number | null, over: Parameters<typeof seedUser>[2] = {}) {
  const facts: NonNullable<ProductUser["facts"]> = daysAgo === null ? {} : { last_active_at: { value: iso(NOW - daysAgo * DAY), at: iso(NOW - HOUR) } };
  return seedUser(db, id, { facts, lastSeenAt: iso(NOW - HOUR), ...over });
}

async function setup(opts: { mode?: DeliveryMode; date?: Partial<DateStart>; settings?: Partial<LifecycleSettings>; catalog?: object; caps?: { sendsPerDay: number; enrolmentsPerDay: number }; testUserIds?: string[] } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const repo = forTenant(system, db);
  await repo.productConnections.update(CONNECTION_ID, { catalog: (opts.catalog ?? CATALOG) as never });
  const { journey, version } = await publishOnboarding(db, {
    mode: opts.mode ?? "live",
    testUserIds: opts.testUserIds ?? [],
    caps: opts.caps,
    settings: { trigger: trigger(opts.date), ...opts.settings },
  });
  const sweep = (nowMs = NOW, pageSize?: number, deadlineMs = nowMs + 60_000) => sweepDateStarts(system, { db, now: () => nowMs, deadlineMs, pageSize });
  const entered = async () =>
    (await repo.lifecycleEnrolments.find({ where: [["journeyId", "==", journey.id]], limit: 100 })).map((e) => e.externalUserId).sort();
  const marker = async () => (await repo.lifecycleJourneys.getById(journey.id))?.dateSweep ?? null;
  return { db, repo, journey, version, sweep, entered, marker };
}

describe("who is past the line", () => {
  it("is anyone whose date is at least the days ago, and not beyond the window", () => {
    const at = (daysAgo: number) => dateEntry(NOW - daysAgo * DAY, START, NOW);
    expect(at(13.9)).toBeNull();
    expect(at(14)).toEqual({ dateAt: iso(NOW - 14 * DAY), days: 14 });
    expect(at(21.9)).toMatchObject({ days: 21 });
    expect(at(22)).toBeNull(); // more than a week past the line
    expect(at(-3)).toBeNull(); // a date still ahead
    expect(dateEntry(null, START, NOW)).toBeNull();
  });
});

describe("the daily check (LIFECYCLE_DATE_START)", () => {
  it("publishing marks the journey, so the check finds it without reading every version", async () => {
    const w = await setup();
    expect(w.journey.startsOnDate).toBe(true);
    expect(w.version.settings.trigger).toMatchObject({ event: DATE_PASSED_EVENT, date: { fact: "last_active_at", days: 14 } });
  });

  it("enrols whoever has crossed the line, and nobody else", async () => {
    const w = await setup();
    quiet(w.db, "active_yesterday", 1);
    quiet(w.db, "quiet_13", 13);
    quiet(w.db, "quiet_14", 14);
    quiet(w.db, "quiet_20", 20);
    quiet(w.db, "gone_for_months", 200);
    quiet(w.db, "never_sent_a_date", null);
    seedUser(w.db, "sent_nonsense", { facts: { last_active_at: { value: "a while back", at: iso(NOW) } } });
    quiet(w.db, "staff", 15, { excluded: { reason: "staff", at: iso(NOW) } });
    quiet(w.db, "opted_out", 15, { subscribed: false });
    expect(await w.sweep()).toEqual({ journeys: 1, checked: 9, enrolled: 2 });
    expect(await w.entered()).toEqual(["quiet_14", "quiet_20"]);
    const [e] = await w.repo.lifecycleEnrolments.find({ where: [["externalUserId", "==", "quiet_14"]], limit: 1 });
    // The journey's clock starts at the check; the date they entered on is kept.
    expect(e).toMatchObject({ source: "trigger", anchorAt: iso(NOW), dateAt: iso(NOW - 14 * DAY), status: "active" });
    expect(e!.log[0]).toMatchObject({ event: "enrolled", detail: "date passed · live" });
  });

  it("runs once a day, from 07:00 UTC, and catches tomorrow whoever crosses the line then", async () => {
    const w = await setup();
    quiet(w.db, "quiet_14", 14);
    quiet(w.db, "quiet_13", 13);
    expect(await w.sweep(NOW - HOUR)).toEqual({ journeys: 0, checked: 0, enrolled: 0 }); // 06:00: too early
    expect(await w.sweep(NOW)).toMatchObject({ journeys: 1, enrolled: 1 });
    expect(await w.marker()).toMatchObject({ day: "20260921", status: "done", enrolled: 1, checked: 2, cursor: null });
    expect(await w.sweep(NOW + 5 * HOUR)).toEqual({ journeys: 0, checked: 0, enrolled: 0 }); // done for today
    expect(await w.sweep(NOW + DAY)).toMatchObject({ journeys: 1, enrolled: 1 });
    expect(await w.marker()).toMatchObject({ day: "20260922", status: "done", enrolled: 1 });
    expect(await w.entered()).toEqual(["quiet_13", "quiet_14"]);
    // Still inside the window the day after: nobody enters twice.
    expect(await w.sweep(NOW + 2 * DAY)).toMatchObject({ journeys: 1, enrolled: 0 });
  });

  it("in test mode takes only the test recipients", async () => {
    const w = await setup({ mode: "test", testUserIds: ["tester"] });
    quiet(w.db, "tester", 15);
    quiet(w.db, "customer", 15);
    expect(await w.sweep()).toMatchObject({ journeys: 1, enrolled: 1 });
    expect(await w.entered()).toEqual(["tester"]);
  });

  it("ends the day at the journey's enrolment cap; the rest enter tomorrow", async () => {
    const w = await setup({ caps: { sendsPerDay: 200, enrolmentsPerDay: 2 } });
    for (const id of ["a", "b", "c", "d"]) quiet(w.db, id, 15);
    expect(await w.sweep()).toMatchObject({ journeys: 1, enrolled: 2 });
    expect(await w.marker()).toMatchObject({ status: "done", enrolled: 2 });
    expect(await w.sweep(NOW + HOUR)).toMatchObject({ journeys: 0 });
    expect(await w.sweep(NOW + DAY)).toMatchObject({ journeys: 1, enrolled: 2 });
    expect(await w.entered()).toEqual(["a", "b", "c", "d"]);
  });

  it("pages through the product's people, and resumes from its cursor on the next tick", async () => {
    const w = await setup();
    for (let i = 0; i < 5; i += 1) quiet(w.db, `u${i}`, 15, { lastSeenAt: iso(NOW - HOUR - i * 60_000) });
    expect(await w.sweep(NOW, 2)).toEqual({ journeys: 1, checked: 5, enrolled: 5 });
    expect(await w.entered()).toEqual(["u0", "u1", "u2", "u3", "u4"]);

    // A check cut short resumes where it stopped: the people seen at or before the cursor, and the day's count carries on.
    const older = quiet(w.db, "older", 15, { lastSeenAt: iso(NOW - 3 * HOUR) });
    quiet(w.db, "newer", 15, { lastSeenAt: iso(NOW - 30 * 60_000) });
    await w.repo.lifecycleJourneys.update(w.journey.id, {
      dateSweep: { day: "20260921", status: "running", cursor: iso(NOW - 2 * HOUR), enrolled: 5, checked: 5, updatedAt: iso(NOW) },
    });
    expect(await w.sweep(NOW + 2 * 60_000, 2)).toEqual({ journeys: 1, checked: 1, enrolled: 1 });
    expect(await w.marker()).toMatchObject({ status: "done", enrolled: 6, checked: 6 });
    expect(await w.entered()).toContain(older.externalUserId);
    expect(await w.entered()).not.toContain("newer"); // read tomorrow: they're still inside the window
    // Out of time before the first page: nothing read, and the marker is untouched.
    await w.repo.lifecycleJourneys.update(w.journey.id, { dateSweep: null });
    expect(await w.sweep(NOW + 3 * 60_000, 2, NOW)).toEqual({ journeys: 0, checked: 0, enrolled: 0 });
    expect(await w.marker()).toBeNull();
  });

  it("checks nothing for a paused product, a paused journey, or with the switch off", async () => {
    const w = await setup();
    quiet(w.db, "quiet_15", 15);
    await w.repo.productConnections.update(CONNECTION_ID, { status: "paused" });
    expect(await w.sweep()).toMatchObject({ journeys: 0, enrolled: 0 });
    await w.repo.productConnections.update(CONNECTION_ID, { status: "active" });
    await w.repo.lifecycleJourneys.update(w.journey.id, { status: "paused" });
    expect(await w.sweep()).toMatchObject({ journeys: 0, enrolled: 0 });
    expect(await w.entered()).toEqual([]);
  });

  it("a product can't start it with an event of the same name", async () => {
    const w = await setup();
    const user = quiet(w.db, "quiet_15", 15);
    const r = await enrolOnEvents(system, { id: CONNECTION_ID, status: "active" }, [{ user, event: DATE_PASSED_EVENT, timestamp: iso(NOW) }], { db: w.db, nowMs: NOW });
    expect(r).toEqual({ enrolled: 0 });
  });

  it("Check now runs today's check again from the start, whatever the hour", async () => {
    const w = await setup();
    quiet(w.db, "quiet_15", 15);
    expect(await w.sweep(NOW)).toMatchObject({ enrolled: 1 });
    quiet(w.db, "quiet_16", 16);
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    const early = NOW + DAY - 3 * HOUR; // 04:00 the next morning
    expect(await checkDatesNow(system, journey, { db: w.db, now: () => early, deadlineMs: early + 60_000 })).toEqual({ checked: 2, enrolled: 1, finished: true });
    expect(await w.entered()).toEqual(["quiet_15", "quiet_16"]);
  });
});

describe("the scheduler's tick", () => {
  const tick = (db: FakeFirestore) =>
    runLifecycleTick({ db, now: () => NOW, listTenants: async () => [{ id: TENANT_ID, region: "eu" } as never], send: async () => ({ ok: true }) as never });

  it("runs the day's check before draining, and not at all with the switch off", async () => {
    const w = await setup({ mode: "shadow" });
    quiet(w.db, "quiet_15", 15);
    delete process.env.LIFECYCLE_DATE_START;
    expect((await tick(w.db)).dateStart).toBeUndefined();
    expect(await w.entered()).toEqual([]);
    process.env.LIFECYCLE_DATE_START = "true";
    expect((await tick(w.db)).dateStart).toEqual({ journeys: 1, checked: 1, enrolled: 1 });
    expect(await w.entered()).toEqual(["quiet_15"]);
  });
});

describe("Check now and enrolling by hand", () => {
  it("Check now needs an active journey that starts when a date passes", async () => {
    const w = await setup();
    quiet(w.db, "quiet_15", 15);
    expect(await checkJourneyDates(ctx, w.journey.id, { db: w.db, now: () => NOW - 5 * HOUR })).toEqual({ status: 200, body: { checked: 1, enrolled: 1, finished: true } });
    await w.repo.lifecycleJourneys.update(w.journey.id, { status: "paused" });
    expect(await checkJourneyDates(ctx, w.journey.id, { db: w.db })).toMatchObject({ status: 409, body: { error: "journey_not_active" } });
    const other = await publishOnboarding(w.db, { mode: "live" });
    expect(await checkJourneyDates(ctx, other.journey.id, { db: w.db })).toMatchObject({ status: 409, body: { error: "not_a_date_start" } });
    delete process.env.LIFECYCLE_DATE_START;
    expect((await checkJourneyDates(ctx, w.journey.id, { db: w.db })).status).toBe(404);
  });

  it("enrolling by hand takes someone wherever their date is, and keeps it", async () => {
    const w = await setup();
    quiet(w.db, "active_yesterday", 1);
    quiet(w.db, "no_date", null);
    expect((await enrolByHand(ctx, w.journey.id, { userId: "active_yesterday" }, w.db, NOW)).status).toBe(201);
    expect((await enrolByHand(ctx, w.journey.id, { userId: "no_date" }, w.db, NOW)).status).toBe(201);
    const rows = await w.repo.lifecycleEnrolments.find({ where: [["journeyId", "==", w.journey.id]], limit: 10 });
    const byUser = Object.fromEntries(rows.map((e) => [e.externalUserId, e]));
    expect(byUser.active_yesterday).toMatchObject({ source: "manual", dateAt: iso(NOW - DAY) });
    expect(byUser.no_date!.dateAt ?? null).toBeNull();
  });
});

describe("what a date start needs before it can be published", () => {
  const codes = async (opts: Parameters<typeof setup>[0], flag = true) => {
    const db = new FakeFirestore();
    seedWorld(db);
    await forTenant(system, db).productConnections.update(CONNECTION_ID, { catalog: (opts?.catalog ?? CATALOG) as never });
    const created = await createLifecycleJourney(ctx, { name: "Nudge", connectionId: CONNECTION_ID, template: "product_onboarding" }, { db });
    if (!created.ok) throw new Error(created.error);
    const draft = created.value.journey.draft;
    if (!flag) delete process.env.LIFECYCLE_DATE_START;
    const saved = await saveLifecycleDraft(ctx, created.value.journey.id, { ...draft, settings: { ...draft.settings, trigger: trigger(opts?.date), ...opts?.settings } }, { db });
    if (!saved.ok) throw new Error(saved.error);
    return saved.value.issues.filter((i) => i.code.startsWith("date_start")).map((i) => (i.detail ? `${i.code}:${i.detail}` : i.code));
  };

  it("a date fact from the catalog", async () => {
    expect(await codes({})).toEqual([]);
    expect(await codes({ date: { fact: "never_heard_of" } })).toEqual(["date_start_fact_unknown:never_heard_of"]);
    const number = { ...CATALOG, facts: [{ ...fact("share_of_voice"), type: "number" as const }] };
    expect(await codes({ catalog: number, date: { fact: "share_of_voice" } })).toEqual(["date_start_fact_not_a_date:share_of_voice"]);
    expect(await codes({ settings: { trigger: { event: DATE_PASSED_EVENT, maxEventAgeHours: 72 } } })).toEqual(["date_start_missing"]);
  });

  it("a journey about the brand, when the date is kept per brand", async () => {
    const perBrand = { ...CATALOG, entityKinds: [{ kind: "brand", label: "brand", plural: "brands", multiple: true, description: "" }], facts: [fact("last_audit_at", "brand")] };
    expect(await codes({ catalog: perBrand, date: { fact: "last_audit_at" } })).toEqual(["date_start_fact_per_entity:brand"]);
    const about = { mode: "each" as const, kind: "brand", pick: "focus" as const, fact: null, includeJoined: false, maxListed: 5 };
    expect(await codes({ catalog: perBrand, date: { fact: "last_audit_at" }, settings: { about } })).toEqual([]);
  });

  it("the switch to be on", async () => {
    expect(await codes({}, false)).toEqual(["date_start_unavailable"]);
  });
});

describe("a date kept per brand", () => {
  const brands = {
    b_quiet: { kind: "brand", name: "Fernlight", parentId: null, role: "owner" as const, steps: {}, facts: { last_audit_at: { value: iso(NOW - 15 * DAY), at: iso(NOW) } }, activeAt: null, firstSeenAt: iso(NOW - 90 * DAY), updatedAt: iso(NOW) },
    b_busy: { kind: "brand", name: "Oakmoss", parentId: null, role: "owner" as const, steps: {}, facts: { last_audit_at: { value: iso(NOW - 2 * DAY), at: iso(NOW) } }, activeAt: null, firstSeenAt: iso(NOW - 90 * DAY), updatedAt: iso(NOW) },
  };
  const catalog = { ...CATALOG, entityKinds: [{ kind: "brand", label: "brand", plural: "brands", multiple: true, description: "" }], facts: [fact("last_audit_at", "brand")] };
  const about = { mode: "each" as const, kind: "brand", pick: "focus" as const, fact: null, includeJoined: false, maxListed: 5 };

  it("is read from each brand, for a journey about each of them", async () => {
    process.env.CONNECT_ENTITIES_ENABLED = "true";
    const w = await setup({ catalog, date: { fact: "last_audit_at" }, settings: { about } });
    const user = seedUser(w.db, "owner", { entities: brands, lastSeenAt: iso(NOW - HOUR) });
    expect(storedDateMs(user, "b_quiet", about, catalog, "last_audit_at")).toBe(NOW - 15 * DAY);
    expect(storedDateMs(user, "b_gone", about, catalog, "last_audit_at")).toBeNull();
    expect(await w.sweep()).toMatchObject({ journeys: 1, enrolled: 1 });
    const rows = await w.repo.lifecycleEnrolments.find({ where: [["journeyId", "==", w.journey.id]], limit: 10 });
    expect(rows).toMatchObject([{ entityId: "b_quiet", dateAt: iso(NOW - 15 * DAY) }]);
  });
});
