import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { JOURNEY_COMPLETED_EVENT, LifecycleSettingsSchema, type LifecycleDraft, type LifecycleJourney } from "@/lib/types/lifecycle";
import type { ProductUser } from "@/lib/types/productUser";
import { enrolOnEvents, enrolUser, enrolmentDocId } from "./enrol";
import { processEnrolment } from "./runner";
import { createLifecycleJourney, publishLifecycleJourney, saveLifecycleDraft, updateLifecycleDelivery } from "./service";
import { followersOf, linkNextJourney } from "./chain";
import { getJourneyDetail, listJourneys, previewJourney } from "./adminApi";
import { validateLifecycleDraft, NO_CATALOG } from "./graph";
import { addDaysToKey, localDateKey } from "./sendWindow";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const TZ = "Europe/London";
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
});

/** A journey that continues from `after`, made as the new-journey form makes it, then (optionally) published. */
async function followOn(
  db: FakeFirestore,
  after: LifecycleJourney,
  opts: { publish?: boolean; testUserIds?: string[]; nowMs?: number; edit?: (d: LifecycleDraft) => LifecycleDraft } = {},
) {
  const nowMs = opts.nowMs ?? T0;
  const created = await createLifecycleJourney(
    ctx,
    { name: "After onboarding", connectionId: CONNECTION_ID, template: "follow_on", afterJourneyId: after.id },
    { db, nowMs },
  );
  if (!created.ok) throw new Error(created.error);
  let journey = created.value.journey;
  if (opts.edit) {
    const saved = await saveLifecycleDraft(ctx, journey.id, opts.edit(journey.draft), { db, nowMs });
    if (!saved.ok) throw new Error(saved.error);
    journey = saved.value.journey;
  }
  const delivery = await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "test", testRecipients: { userIds: opts.testUserIds ?? [], emails: [] } }, { db, nowMs });
  if (!delivery.ok) throw new Error(delivery.error);
  if (opts.publish === false) return (await forTenant(system, db).lifecycleJourneys.getById(journey.id))!;
  const published = await publishLifecycleJourney(ctx, journey.id, { db, nowMs });
  if (!published.ok) throw new Error(`${published.error} ${JSON.stringify(published.detail)}`);
  return published.value.journey;
}

/** One person part-way through the onboarding journey, and a runner that plays it to its end. */
async function world(opts: { testUserIds?: string[] } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  const { journey: first, version } = await publishOnboarding(db, { mode: "test", testUserIds: opts.testUserIds ?? ["alex"] });
  const enrolled = await enrolUser(system, { journey: first, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  expect(enrolled.outcome).toBe("enrolled");

  let now = T0;
  const sends = sendStub();
  const deps = { db, now: () => now, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext };
  const repo = forTenant(system, db);
  const enrolment = (journey: LifecycleJourney, u: ProductUser = user) => repo.lifecycleEnrolments.getById(enrolmentDocId(journey.id, u.id));
  /** Run the journey's enrolment each time it comes due, until it finishes. */
  const play = async (journey: LifecycleJourney) => {
    for (let i = 0; i < 60; i += 1) {
      const e = await enrolment(journey);
      if (!e || e.status !== "active" || !e.nextRunAt) return e;
      now = Math.max(now, Date.parse(e.nextRunAt));
      await processEnrolment(system, e.id, deps);
    }
    throw new Error("the journey never finished");
  };
  return { db, user, first, repo, sends, deps, enrolment, play, now: () => now, setNow: (ms: number) => (now = ms) };
}

describe("a journey that continues from another: validation and publish", () => {
  it("must name the journey it continues from, and only a product journey can", () => {
    const draft = (afterJourneyId?: string) => ({
      graph: { nodes: [], edges: [] },
      pools: [],
      settings: LifecycleSettingsSchema.parse({ trigger: { event: JOURNEY_COMPLETED_EVENT, afterJourneyId } }),
    });
    const codes = (...a: Parameters<typeof validateLifecycleDraft>) => validateLifecycleDraft(...a).issues.map((i) => i.code);
    expect(codes(draft(), NO_CATALOG)).toContain("continue_from_missing");
    expect(codes(draft("lcj_a"), NO_CATALOG)).not.toContain("continue_from_missing");
    expect(codes(draft("lcj_a"), NO_CATALOG, { upstream: "loop" })).toContain("continue_from_loop");
    expect(codes(draft("lcj_a"), NO_CATALOG, { upstream: "ok" }).filter((c) => c.startsWith("continue_from"))).toEqual([]);
    expect(codes(draft("lcj_a"), NO_CATALOG, { audience: "waitlist" })).toContain("continue_from_product_only");
  });

  it("the follow-on template is a valid journey that starts after the first, in its window and from its sender", async () => {
    const w = await world();
    const next = await followOn(w.db, w.first, { publish: false });
    expect(next.draft.settings.trigger).toMatchObject({ event: JOURNEY_COMPLETED_EVENT, afterJourneyId: w.first.id });
    expect(next.draft.settings.sendPolicy).toMatchObject({ days: w.first.draft.settings.sendPolicy.days, startHour: 9 });
    expect(next.draft.settings.category).toEqual(w.first.draft.settings.category);
    expect(next.draft.graph.nodes.find((n) => n.type === "trigger")!.data.label).toBe("Finished Onboarding");
    expect(next.draft.pools[0]!.items).toHaveLength(4);
    const published = await publishLifecycleJourney(ctx, next.id, { db: w.db, nowMs: T0 });
    if (!published.ok) throw new Error(JSON.stringify(published.detail));
    expect(published.value.journey.continuesFrom).toBe(w.first.id);
    // The first journey was never republished and names nothing itself.
    expect((await w.repo.lifecycleJourneys.getById(w.first.id))!.publishedVersion).toBe(1);
  });

  it("can't be created after a journey that's missing, or published once that journey is gone", async () => {
    const w = await world();
    const missing = await createLifecycleJourney(ctx, { name: "x", connectionId: CONNECTION_ID, template: "follow_on", afterJourneyId: "lcj_nope" }, { db: w.db });
    expect(missing).toMatchObject({ ok: false, error: "after_journey_not_found" });
    expect(await createLifecycleJourney(ctx, { name: "x", connectionId: CONNECTION_ID, template: "follow_on" }, { db: w.db })).toMatchObject({
      ok: false,
      error: "after_journey_required",
    });

    const next = await followOn(w.db, w.first, { publish: false });
    await w.repo.lifecycleJourneys.update(w.first.id, { status: "archived" });
    const refused = await publishLifecycleJourney(ctx, next.id, { db: w.db });
    expect(refused).toMatchObject({ ok: false, status: 422, error: "invalid_journey" });
    expect(JSON.stringify((refused as { detail?: unknown }).detail)).toContain("continue_from_not_found");
  });

  it("is refused while journey links are off", async () => {
    const w = await world();
    delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
    const r = await createLifecycleJourney(ctx, { name: "x", connectionId: CONNECTION_ID, template: "follow_on", afterJourneyId: w.first.id }, { db: w.db });
    expect(r).toMatchObject({ ok: false, error: "journey_links_unavailable" });
  });
});

describe("handing people on at the end of a journey", () => {
  it("someone part-way through the first journey carries on into the next when they reach its end", async () => {
    const w = await world();
    // Built and published AFTER they started the first journey, which is never republished.
    const next = await followOn(w.db, w.first, {
      testUserIds: ["alex"],
      edit: (d) => ({ ...d, settings: { ...d.settings, sendPolicy: { ...d.settings.sendPolicy, days: EVERY_DAY } } }),
    });
    expect(await w.enrolment(next)).toBeNull();

    const done = await w.play(w.first);
    expect(done!.status).toBe("completed");
    expect(done!.log.map((l) => l.event)).toContain("continued");
    const finishedAt = w.now();

    const handed = await w.enrolment(next);
    expect(handed).toMatchObject({ status: "active", source: "trigger", fromJourneyId: w.first.id, journeyId: next.id });
    // Its clock starts the moment they finished — not at sign-up.
    expect(Date.parse(handed!.anchorAt)).toBe(finishedAt);
    expect(handed!.log[0]!.detail).toContain("finished the journey before");

    // The first follow-up is booked 3 days on, in their window — a 72-hour wait would slip to day 4.
    w.setNow(finishedAt + 60_000);
    await processEnrolment(system, handed!.id, w.deps);
    const waiting = await w.enrolment(next);
    expect(localDateKey(Date.parse(waiting!.nextRunAt!), TZ)).toBe(addDaysToKey(localDateKey(finishedAt, TZ), 3));

    // And it plays through: four more emails, then it too reaches its end.
    const before = w.sends.sent.length;
    const end = await w.play(next);
    expect(end!.status).toBe("completed");
    expect(w.sends.sent.length - before).toBe(4);
  });

  it("hands nobody on while journey links are off, or when they're stopped before the end", async () => {
    const off = await world();
    const next = await followOn(off.db, off.first, { testUserIds: ["alex"] });
    delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
    expect((await off.play(off.first))!.status).toBe("completed");
    expect(await off.enrolment(next)).toBeNull();

    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    const stopped = await world();
    const after = await followOn(stopped.db, stopped.first, { testUserIds: ["alex"] });
    // They leave the product part-way through.
    await processEnrolment(system, (await stopped.enrolment(stopped.first))!.id, stopped.deps);
    await stopped.repo.productUsers.update(stopped.user.id, { subscribed: false });
    const end = await stopped.play(stopped.first);
    expect(end).toMatchObject({ status: "exited", stopReason: "unsubscribed_in_product" });
    expect(await stopped.enrolment(after)).toBeNull();
  });

  it("applies the next journey's own entry rules, and says why someone wasn't taken", async () => {
    const w = await world();
    // The next journey is in test mode and this person isn't one of its test recipients.
    const next = await followOn(w.db, w.first, { testUserIds: [] });
    const done = await w.play(w.first);
    expect(done!.status).toBe("completed");
    expect(await w.enrolment(next)).toBeNull();
    const note = done!.log.find((l) => l.event === "not_continued");
    expect(note?.detail).toBe("After onboarding: not a test recipient");
  });

  it("a hand-on that keeps failing is retried, then the first journey still finishes", async () => {
    const w = await world();
    const next = await followOn(w.db, w.first, { testUserIds: ["alex"] });
    // The next journey's published version is damaged, so nobody can be enrolled into it.
    await w.repo.lifecycleVersions.update(`${next.id}_v1`, { graph: {} as never });
    const done = (await w.play(w.first))!;
    expect(done.status).toBe("completed");
    // Three failed runs (the log keeps one line for a repeated failure), then it finishes without handing on.
    expect(done.log.filter((l) => l.event === "run_failed")).toHaveLength(1);
    expect(done.log.find((l) => l.event === "not_continued")?.detail).toContain("couldn't hand on");
    expect(await w.enrolment(next)).toBeNull();
    // Nothing was sent twice along the way, and the last email is on record as sent.
    expect(w.sends.sent).toHaveLength(5);
    expect(done.sentItems.map((s) => s.status)).toEqual(Array(5).fill("sent"));
  });

  it("only takes people from the journey it names: not from a product event of the same name, not a draft link, not a paused journey", async () => {
    const w = await world();
    const next = await followOn(w.db, w.first, { testUserIds: ["alex"] });
    const connection = (await w.repo.productConnections.getById(CONNECTION_ID))!;
    const r = await enrolOnEvents(system, connection, [{ user: w.user, event: JOURNEY_COMPLETED_EVENT, timestamp: iso(T0) }], { db: w.db, nowMs: T0 });
    expect(r.enrolled).toBe(0);
    expect(await w.enrolment(next)).toBeNull();

    expect((await followersOf(system, w.first, w.db)).map((f) => f.journey.id)).toEqual([next.id]);
    await w.repo.lifecycleJourneys.update(next.id, { status: "paused" });
    expect(await followersOf(system, w.first, w.db)).toEqual([]);
    // A link that only exists in a draft isn't live.
    const draftOnly = await followOn(w.db, w.first, { publish: false });
    expect(draftOnly.continuesFrom ?? null).toBeNull();
    expect(await followersOf(system, w.first, w.db)).toEqual([]);
  });
});

describe("setting the link from the end of the earlier journey", () => {
  it("changes only the next journey's draft trigger, and refuses a loop", async () => {
    const w = await world();
    const { journey: other } = await publishOnboarding(w.db, { mode: "test", testUserIds: [] });
    const linked = await linkNextJourney(ctx, w.first.id, { nextJourneyId: other.id }, { db: w.db });
    if (!linked.ok) throw new Error(linked.error);
    const now = (await w.repo.lifecycleJourneys.getById(other.id))!;
    expect(now.draft.settings.trigger).toMatchObject({ event: JOURNEY_COMPLETED_EVENT, afterJourneyId: w.first.id });
    expect(now.draft.graph).toEqual(other.draft.graph);
    // Its published version still starts on sign-up until a person publishes it.
    expect(now.publishedVersion).toBe(1);
    expect(now.continuesFrom ?? null).toBeNull();
    expect((await w.repo.lifecycleVersions.getById(`${other.id}_v1`))!.settings.trigger.event).toBe("user.signed_up");

    expect(await linkNextJourney(ctx, other.id, { nextJourneyId: w.first.id }, { db: w.db })).toMatchObject({ ok: false, status: 409, error: "continue_from_loop" });
    expect(await linkNextJourney(ctx, w.first.id, { nextJourneyId: w.first.id }, { db: w.db })).toMatchObject({ ok: false, error: "continue_from_self" });
    expect(await linkNextJourney(ctx, w.first.id, { nextJourneyId: "lcj_nope" }, { db: w.db })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the editor's view of the link", () => {
  it("both ends show it, and say whether it's live", async () => {
    const w = await world();
    const next = await followOn(w.db, w.first, { publish: false });
    type Detail = { chain: { from: unknown; next: Array<Record<string, unknown>>; journeys: Array<{ id: string; timeline: { text: string } | null }> }; features: { journeyLinks?: boolean } };
    const detail = async (id: string) => (await getJourneyDetail(ctx, id, w.db)).body as Detail;

    let first = await detail(w.first.id);
    expect(first.features.journeyLinks).toBe(true);
    expect(first.chain.from).toBeNull();
    expect(first.chain.next).toEqual([{ id: next.id, name: "After onboarding", status: "draft", published: false, draft: true, live: false }]);
    expect((await detail(next.id)).chain.from).toEqual({ id: w.first.id, name: "Onboarding", problem: null, live: false });
    // The journey it continues from comes with its timeline, read from that journey.
    expect((await detail(next.id)).chain.journeys.find((j) => j.id === w.first.id)!.timeline!.text).toMatch(/^5 emails over about \d+ days/);

    await publishLifecycleJourney(ctx, next.id, { db: w.db, nowMs: T0 });
    first = await detail(w.first.id);
    expect(first.chain.next[0]).toMatchObject({ id: next.id, live: true, published: true, draft: true });
    expect((await detail(next.id)).chain.from).toMatchObject({ id: w.first.id, live: true });

    const list = (await listJourneys(ctx, {}, w.db)).body as { features?: { journeyLinks: boolean }; journeys: Array<{ id: string; continuesFrom: unknown; timeline: { emails: number } | null }> };
    expect(list.features).toEqual({ journeyLinks: true });
    expect(list.journeys.find((j) => j.id === next.id)!.continuesFrom).toEqual({ id: w.first.id, name: "Onboarding" });
    expect(list.journeys.find((j) => j.id === next.id)!.timeline!.emails).toBe(4);

    delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
    const offDetail = (await getJourneyDetail(ctx, w.first.id, w.db)).body as Partial<Detail>;
    expect(offDetail.chain).toBeUndefined();
    expect(offDetail.features!.journeyLinks).toBeUndefined();
    expect(((await listJourneys(ctx, {}, w.db)).body as { features?: unknown }).features).toBeUndefined();
  });

  it("the timeline preview walks the first journey, then starts this one where it ends", async () => {
    const w = await world();
    const next = await followOn(w.db, w.first, { publish: false });
    type Step = { atMs: number; day: number; kind: string };
    const r = await previewJourney(ctx, next.id, { anchorAt: iso(T0), timezone: TZ }, w.db, T0);
    const body = r.body as { steps: Step[]; before: Array<{ journeyId: string; name: string; steps: Step[] }>; reached: boolean; startsAt: string };
    expect(body.before.map((b) => b.journeyId)).toEqual([w.first.id]);
    expect(body.reached).toBe(true);
    const lastBefore = body.before[0]!.steps.at(-1)!;
    expect(lastBefore.kind).toBe("complete");
    expect(Date.parse(body.startsAt)).toBe(lastBefore.atMs);
    const sends = body.steps.filter((s) => s.kind === "send");
    expect(sends).toHaveLength(4);
    // Days run on from sign-up, and the first follow-up is at least 3 days after the first journey ended.
    expect(sends[0]!.atMs - lastBefore.atMs).toBeGreaterThan(2.5 * 86_400_000);
    expect(sends[0]!.day).toBeGreaterThan(lastBefore.day);

    // The first journey's own preview is unchanged.
    const own = (await previewJourney(ctx, w.first.id, { anchorAt: iso(T0), timezone: TZ }, w.db, T0)).body as { before?: unknown };
    expect(own.before).toBeUndefined();
  });
});
