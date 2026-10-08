import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { TenantCollection } from "@/lib/tenant/repository";
import { DATE_PASSED_EVENT, type DateStart, type DeliveryMode, type LifecycleSettings } from "@/lib/types/lifecycle";
import type { ProductUser } from "@/lib/types/productUser";
import { checkJourneyDates, enrolByHand, journeyAnalytics } from "./adminApi";
import { checkDatesNow, decideEntry, mayEnter, storedDateMs, sweepDateStarts } from "./dateStart";
import { enrolmentDocId, enrolOnEvents } from "./enrol";
import { processEnrolment, runLifecycleTick } from "./runner";
import { createLifecycleJourney, publishLifecycleJourney, saveLifecycleDraft } from "./service";
import { CONNECTION_ID, STEPS, T0, TENANT_ID, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";
import type { ProductContext } from "@/lib/connect/protocol";

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
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_GO_LIVE_SWEEP = "true";
  process.env.CONNECT_DATE_FACTS = "true";
  process.env.LIFECYCLE_DATE_START = "true";
});
afterEach(() => {
  for (const k of ["EMAIL_LINK_ORIGIN", "LIFECYCLE_MODE_CEILING", "LIFECYCLE_GO_LIVE_SWEEP", "CONNECT_DATE_FACTS", "LIFECYCLE_DATE_START", "CONNECT_ENTITIES_ENABLED"]) delete process.env[k];
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
  const AGAIN = { ...START, reenterAfterDays: 30 };
  const entry = (status: string, daysAgo: number) => ({ status, createdAt: iso(NOW - daysAgo * DAY) });

  it("is anyone whose date is at least the days ago, and not beyond the window", () => {
    const at = (daysAgo: number) => decideEntry(NOW - daysAgo * DAY, START, [], NOW);
    expect(at(13.9)).toBe("not_yet");
    expect(at(14)).toBe("enter");
    expect(at(21.9)).toBe("enter");
    expect(at(22)).toBe("window_passed"); // more than a week past the line
    expect(at(-3)).toBe("not_yet"); // a date still ahead
  });

  it("each person enters once, unless the journey lets them in again", () => {
    expect(decideEntry(NOW - 14 * DAY, START, [entry("exited", 60)], NOW)).toBe("entered_before");
    expect(decideEntry(NOW - 14 * DAY, AGAIN, [entry("exited", 60)], NOW)).toBe("enter");
  });

  it("never while an earlier entry is still running, and no sooner than the gap after the last one", () => {
    expect(decideEntry(NOW - 14 * DAY, AGAIN, [entry("active", 60)], NOW)).toBe("in_journey");
    expect(decideEntry(NOW - 14 * DAY, AGAIN, [entry("exited", 29.9)], NOW)).toBe("too_soon");
    expect(decideEntry(NOW - 14 * DAY, AGAIN, [entry("completed", 30)], NOW)).toBe("enter");
    expect(decideEntry(NOW - 14 * DAY, AGAIN, [entry("exited", 90), entry("exited", 10)], NOW)).toBe("too_soon"); // the latest counts
  });

  it("someone held back only by the gap enters when it ends, and the window counts from there", () => {
    // Quiet for 25 days: past the line's own window, but the gap after their last entry ended today.
    expect(decideEntry(NOW - 25 * DAY, AGAIN, [entry("exited", 30)], NOW)).toBe("enter");
    expect(decideEntry(NOW - 25 * DAY, AGAIN, [entry("exited", 37.9)], NOW)).toBe("enter");
    expect(decideEntry(NOW - 33 * DAY, AGAIN, [entry("exited", 38)], NOW)).toBe("window_passed");
    expect(decideEntry(NOW - 25 * DAY, AGAIN, [], NOW)).toBe("window_passed"); // nobody held them back
  });

  it("by hand ignores the line, the window and the gap, but not the other two", () => {
    const byHand = { byHand: true };
    expect(decideEntry(NOW - DAY, AGAIN, [entry("exited", 2)], NOW, byHand)).toBe("enter");
    expect(decideEntry(NOW - DAY, AGAIN, [entry("active", 2)], NOW, byHand)).toBe("in_journey");
    expect(decideEntry(NOW - DAY, START, [entry("exited", 200)], NOW, byHand)).toBe("entered_before");
  });

  it("the daily check only looks closer at dates that could still enter", () => {
    const worth = (daysAgo: number | null, start = START) => mayEnter(daysAgo === null ? null : NOW - daysAgo * DAY, start, NOW);
    expect([worth(null), worth(13.9), worth(14), worth(21.9), worth(22), worth(200)]).toEqual([false, false, true, true, false, false]);
    // Entering again: a gap can hold someone back past the line's own window, so the look reaches further.
    expect([worth(22, AGAIN), worth(39.9, AGAIN), worth(40, AGAIN)]).toEqual([true, true, false]);
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

  it("counts the people it couldn't decide about, carries on, and looks at them again tomorrow", async () => {
    const w = await setup();
    quiet(w.db, "fine", 15);
    const unlucky = quiet(w.db, "unlucky", 15);
    // One person's enrolment read fails today.
    const read = TenantCollection.prototype.getById;
    let failing = true;
    const spy = vi.spyOn(TenantCollection.prototype, "getById").mockImplementation(function (this: TenantCollection<{ id: string; tenantId: string }>, id: string) {
      if (failing && id === enrolmentDocId(w.journey.id, unlucky.id)) return Promise.reject(new Error("unavailable"));
      return read.call(this, id);
    });
    onTestFinished(() => spy.mockRestore());
    expect(await w.sweep(NOW)).toEqual({ journeys: 1, checked: 2, enrolled: 1, failed: 1 });
    expect(await w.marker()).toMatchObject({ status: "done", enrolled: 1, checked: 2, failed: 1 });
    expect(await w.entered()).toEqual(["fine"]);
    failing = false;
    expect(await w.sweep(NOW + DAY)).toEqual({ journeys: 1, checked: 2, enrolled: 1 });
    expect((await w.marker())?.failed).toBeUndefined();
    expect(await w.entered()).toEqual(["fine", "unlucky"]);
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

describe("stopping when the date moves on", () => {
  const MIN = 60_000;
  /** One person, quiet for 15 days, enrolled by the day's check; the welcome has gone out. */
  async function nudged(date: Partial<DateStart> = {}) {
    const w = await setup({ date });
    const user = quiet(w.db, "alex", 15);
    expect(await w.sweep()).toMatchObject({ enrolled: 1 });
    const [enrolment] = await w.repo.lifecycleEnrolments.find({ where: [["journeyId", "==", w.journey.id]], limit: 1 });
    let context: ProductContext | null = productContext();
    const live = contextStub(() => context);
    const sends = sendStub();
    let now = NOW;
    const deps = { db: w.db, now: () => now, send: sends.send, fetchContext: live.fetchContext };
    const run = (at: number) => {
      now = at;
      return processEnrolment(system, enrolment!.id, deps);
    };
    const get = async () => (await w.repo.lifecycleEnrolments.getById(enrolment!.id))!;
    expect(await run(NOW)).toBe("waiting");
    expect(await run(NOW + 15 * MIN)).toBe("sent");
    const nextAt = Date.parse((await get()).nextRunAt!);
    const cameBack = (atMs: number) => w.repo.productUsers.update(user.id, { facts: { last_active_at: { value: iso(atMs), at: iso(atMs) } } });
    return { ...w, user, run, get, nextAt, sent: sends.sent, contextCalls: live.calls, setContext: (c: ProductContext | null) => (context = c), cameBack };
  }
  const liveDate = (value: unknown) => productContext({ facts: [{ id: "last_active_at", label: "Last active", value: value as string }] });

  it("stops before the next email once the stored date is later than the one they entered on", async () => {
    const w = await nudged();
    await w.cameBack(NOW + HOUR);
    expect(await w.run(w.nextAt)).toBe("exited");
    expect(await w.get()).toMatchObject({ status: "exited", stopReason: "date_moved", cursor: null });
    expect(w.sent).toHaveLength(1);
    expect(w.contextCalls).toHaveLength(1); // the product isn't asked again: the stored date was enough
  });

  it("stops on the product's live answer, when the stored date is still the old one", async () => {
    const w = await nudged();
    w.setContext(liveDate(iso(w.nextAt - HOUR))); // back an hour before the email was due
    expect(await w.run(w.nextAt)).toBe("exited");
    expect(await w.get()).toMatchObject({ status: "exited", stopReason: "date_moved" });
    expect(w.sent).toHaveLength(1);
  });

  it("carries on while the date is the same, unknown, or not a date", async () => {
    for (const context of [liveDate(iso(NOW - 15 * DAY)), liveDate("recently"), productContext(), null]) {
      const w = await nudged();
      w.setContext(context);
      expect(await w.run(w.nextAt)).toBe("sent");
      expect(w.sent).toHaveLength(2);
    }
    // The fact was removed from their state: nothing to compare, so nobody is stopped.
    const w = await nudged();
    await w.repo.productUsers.update(w.user.id, { facts: {} });
    expect(await w.run(w.nextAt)).toBe("sent");
  });

  it("carries on when the journey doesn't stop on it, or the switch is off", async () => {
    const kept = await nudged({ stopWhenDateMoves: false });
    await kept.cameBack(NOW + HOUR);
    expect(await kept.run(kept.nextAt)).toBe("sent");
    const off = await nudged();
    await off.cameBack(NOW + HOUR);
    delete process.env.LIFECYCLE_DATE_START;
    expect(await off.run(off.nextAt)).toBe("sent");
  });
});

describe("entering again after a new quiet spell", () => {
  /** Alex went quiet 14 days ago, entered today, came back in two days and went quiet again from then. */
  async function cameBackBriefly(date: Partial<DateStart> = { reenterAfterDays: 30 }) {
    const w = await setup({ date });
    const user = quiet(w.db, "alex", 14);
    expect(await w.sweep(NOW)).toMatchObject({ enrolled: 1 });
    const rows = () => w.repo.lifecycleEnrolments.find({ where: [["journeyId", "==", w.journey.id]], limit: 20 });
    const [first] = await rows();
    const finish = (id: string) => w.repo.lifecycleEnrolments.update(id, { status: "exited", stopReason: "date_moved", cursor: null, nextRunAt: null });
    const lastActive = (ms: number) => w.repo.productUsers.update(user.id, { facts: { last_active_at: { value: iso(ms), at: iso(ms) } }, lastSeenAt: iso(ms) });
    return { ...w, user, first: first!, rows, finish, lastActive };
  }

  it("one date is one entry, however many days it stays past the line", async () => {
    const w = await cameBackBriefly();
    await w.finish(w.first.id);
    for (const d of [1, 2, 7, 30, 31]) expect(await w.sweep(NOW + d * DAY)).toMatchObject({ enrolled: 0 });
    expect(await w.rows()).toHaveLength(1);
  });

  it("lets them in again once their date has moved on and passed the line, no sooner than the gap", async () => {
    const w = await cameBackBriefly();
    await w.lastActive(NOW + 2 * DAY);
    await w.finish(w.first.id);
    // Quiet again from day 2: past the line on day 16, but only 16 days after they last entered.
    expect(await w.sweep(NOW + 16 * DAY)).toMatchObject({ enrolled: 0 });
    expect(await w.sweep(NOW + 29 * DAY)).toMatchObject({ enrolled: 0 });
    // Day 30: the gap is over. They've been quiet 28 days — past the line's own window, held back only by the gap.
    expect(await w.sweep(NOW + 30 * DAY)).toMatchObject({ enrolled: 1 });
    const rows = await w.rows();
    expect(rows.map((e) => e.dateAt).sort()).toEqual([iso(NOW - 14 * DAY), iso(NOW + 2 * DAY)]);
    expect(new Set(rows.map((e) => e.id)).size).toBe(2);
    expect(await w.sweep(NOW + 31 * DAY)).toMatchObject({ enrolled: 0 }); // the new one is running
  });

  it("never enters them twice at once", async () => {
    const w = await cameBackBriefly({ reenterAfterDays: 1, stopWhenDateMoves: false });
    await w.lastActive(NOW + 2 * DAY);
    expect(await w.sweep(NOW + 16 * DAY)).toMatchObject({ enrolled: 0 }); // the first entry is still running
    await w.finish(w.first.id);
    expect(await w.sweep(NOW + 17 * DAY)).toMatchObject({ enrolled: 1 });
  });

  it("each person enters once when the journey says so, whatever their date does", async () => {
    const w = await cameBackBriefly({ reenterAfterDays: null });
    await w.lastActive(NOW + 2 * DAY);
    await w.finish(w.first.id);
    for (const d of [16, 30, 60]) expect(await w.sweep(NOW + d * DAY)).toMatchObject({ enrolled: 0 });
    expect(await w.rows()).toHaveLength(1);
  });

  it("counts an entry from before the journey let people in again", async () => {
    // Entered while people entered once (an id without the date), then the journey was republished to let them in again.
    const w = await cameBackBriefly({ reenterAfterDays: null });
    await w.lastActive(NOW + 2 * DAY);
    await w.finish(w.first.id);
    const draft = (await w.repo.lifecycleJourneys.getById(w.journey.id))!.draft;
    expect((await saveLifecycleDraft(ctx, w.journey.id, { ...draft, settings: { ...draft.settings, trigger: trigger({ reenterAfterDays: 30 }) } }, { db: w.db })).ok).toBe(true);
    expect((await publishLifecycleJourney(ctx, w.journey.id, { db: w.db })).ok).toBe(true);
    expect(await w.sweep(NOW + 20 * DAY)).toMatchObject({ enrolled: 0 }); // 20 days since that entry
    expect(await w.sweep(NOW + 30 * DAY)).toMatchObject({ enrolled: 1 });
  });

  it("by hand skips the gap, but not someone still in the journey", async () => {
    const w = await cameBackBriefly();
    expect(await enrolByHand(ctx, w.journey.id, { userId: "alex" }, w.db, NOW + DAY)).toMatchObject({ status: 409, body: { error: "already_enrolled", detail: w.first.id } });
    await w.lastActive(NOW + 2 * DAY);
    await w.finish(w.first.id);
    expect((await enrolByHand(ctx, w.journey.id, { userId: "alex" }, w.db, NOW + 3 * DAY)).status).toBe(201);
    expect(await w.rows()).toHaveLength(2);
  });

  it("the journey's numbers count people as well as entries", async () => {
    const w = await cameBackBriefly();
    await w.lastActive(NOW + 2 * DAY);
    await w.finish(w.first.id);
    await w.sweep(NOW + 30 * DAY);
    quiet(w.db, "sam", null, { facts: { last_active_at: { value: iso(NOW + 16 * DAY), at: iso(NOW + 16 * DAY) } } });
    await w.sweep(NOW + 31 * DAY);
    const stats = (await journeyAnalytics(ctx, w.journey.id, w.db)).body as { enrolments: { total: number; people: number; stopReasons: Record<string, number> } };
    expect(stats.enrolments).toMatchObject({ total: 3, people: 2, stopReasons: { date_moved: 1 } });
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

  it("one brand's entry doesn't hold another brand back", async () => {
    process.env.CONNECT_ENTITIES_ENABLED = "true";
    const w = await setup({ catalog, date: { fact: "last_audit_at", reenterAfterDays: 30 }, settings: { about } });
    seedUser(w.db, "owner", { entities: brands, lastSeenAt: iso(NOW - HOUR) });
    expect(await w.sweep()).toMatchObject({ enrolled: 1 }); // Fernlight, still running
    // Twelve days on Oakmoss crosses the line too: its own entry, the same day.
    expect(await w.sweep(NOW + 12 * DAY)).toMatchObject({ enrolled: 1 });
    const rows = await w.repo.lifecycleEnrolments.find({ where: [["journeyId", "==", w.journey.id]], limit: 10 });
    expect(rows.map((e) => e.entityId).sort()).toEqual(["b_busy", "b_quiet"]);
  });
});
