import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { isStoredTimestamp, timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { forTenant, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import { listOpenAgentActions } from "@/lib/ontology/agentActions";
import { AgentActionSchema, type AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ID, type DataSignal } from "@/lib/types/dataSignal";
import type { MetricSnapshot } from "@/lib/types/metricSnapshot";
import { planningId } from "../keys";
import { addDays } from "../period";
import { cutRows, putSnapshot, ttlFor } from "../snapshots";
import { LAST_DAY, page, search, seedSearchConsole, writeDays, writePlanning } from "../testing/signals";
import { addDay, CAPS, detectConnection, losingPages, NEAR_SUBJECT, newTally, pageOf, risingSearches, topicOf, withinReach, type MapView } from "./detect";
import { DATA_SIGNAL_ACTION, SIGNALS_REVIEW_HREF } from "./names";
import { dismissSignal } from "./review";
import { blankSignal } from "./store";

// Detecting what collected numbers suggest: the rules on made-up days, cuts and floors, caps,
// repeats, staleness, and planning connections only. Every site, search and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const ID = "dcn_ssssssssssssssssssss";
const NOW = new Date("2026-11-23T10:00:00.000Z");
const DAY = 86_400_000;

let db: FakeFirestore;
const load = async () => (await forTenant(A, db).dataConnections.getById(ID))!;
const rows = async () => (await forTenant(A, db).dataSignals.find()) as DataSignal[];
const actions = async () => (await forTenant(A, db).agentActions.find()).map((a) => AgentActionSchema.parse(a) as AgentAction);

/** A map with two decided subjects, a monstera question, and "pet" searches near Pet safe plants. */
const mapView = (over: Partial<MapView> = {}): MapView => ({
  atScale: false,
  subjects: 2,
  hasWords: async () => new Set(),
  questionsOf: async () => [],
  questionText: async (ids) => new Map(ids.map((id) => [id, "How often should I water a monstera?"] as const)),
  nearest: async (texts) => texts.map((t) => (t.includes("pet") ? { ref: "sub_pets00000000", sim: 0.8 } : t.includes("monstera") ? { ref: "sub_water0000000", sim: 0.7 } : null)),
  ...over,
});

/** 28 topic days: "pet safe hanging plants" rising, a small one, and a steady one. */
async function topics(extra: (day: string, i: number) => ReturnType<typeof search>[] = () => []) {
  await writeDays(A, db, ID, "topic", 28, (day, i) => [
    ...(i < 14 ? (i < 10 ? [search("pet safe hanging plants", 4)] : []) : i < 27 ? [search("pet safe hanging plants", 20, 1)] : []),
    ...(i >= 14 ? [search("tiny search", 2)] : []),
    search("monstera care", 30, 3),
    ...extra(day, i),
  ]);
}

/** 56 page days: /care/fiddle-leaf-fig losing clicks, a small page, a steady page. */
async function pages() {
  await writeDays(A, db, ID, "page", 56, (_day, i) => [
    page("/care/fiddle-leaf-fig", i < 28 ? (i < 24 ? 4 : 0) : i < 28 + 20 ? 2 : i < 28 + 21 ? 1 : 0),
    page("/care/small", i < 28 ? 1 : 0),
    page("/care/monstera", 10),
  ]);
}

async function questions() {
  await writePlanning(A, db, ID, "question", [
    { key: "q_monstera000000000", label: "how often to water monstera", subjectId: "sub_water0000000", m: { searchClicks: 40, searchImpressions: 1900, searchPosition: 8.6, searchCtr: 0.02 } },
    { key: "q_top0000000000000", label: "monstera care", subjectId: "sub_water0000000", m: { searchClicks: 90, searchImpressions: 840, searchPosition: 3.1 } },
  ]);
}

async function rolledTopics() {
  const doc: Omit<MetricSnapshot, "id" | "tenantId"> = {
    connectionId: ID,
    gen: 0,
    account: "sc-domain:fernhill.example",
    connectorId: "search-console",
    stream: "search_performance",
    by: "topic",
    day: null,
    window: { from: addDays(LAST_DAY, -27), to: LAST_DAY },
    days: 28,
    timeZone: "America/Los_Angeles",
    final: true,
    totals: null,
    rows: [search("pet safe hanging plants", 300, 9, 7.9), search("pet friendly plants", 120, 4), search("monstera care", 840, 90, 3.1), search("unrelated words", 50, 1)],
    rowsSeen: 4,
    rowsDropped: 0,
    more: false,
    floor: null,
    basis: null,
    notes: [],
    collectedAt: NOW.toISOString(),
    ttlAt: ttlFor(LAST_DAY, 90),
  };
  await putSnapshot(A, `${ID}_0_search_performance_topic_r28`, doc, { db });
}

beforeEach(async () => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
  await seedSearchConsole(A, db, ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the rules", () => {
  /** A 28 day tally of one search: impressions on each day before and after the split. */
  const rising = (before: number[], now: number[], cut: number[] = [], floor = 0) => {
    const t = newTally(LAST_DAY, 14, 14);
    t.days.forEach((day, i) => {
      const value = i < 14 ? before[i] : now[i - 14];
      const isCut = cut.includes(i);
      addDay(t, { day, rows: value ? [search("pet safe hanging plants", value)] : [], rowsDropped: isCut ? 10 : 0, more: false, floor: isCut ? { searchClicks: 0, searchImpressions: floor } : null }, topicOf);
    });
    return risingSearches(t);
  };
  const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

  it("finds a rising search: 50 impressions on 4 days or more, double the 14 before, or 80 when new", () => {
    expect(rising(fill(14, 2), [...fill(4, 15), ...fill(10, 0)])).toMatchObject([{ label: "pet safe hanging plants", impressions: 60, before: 28, daysSeen: 4 }]);
    // Under 50, or on 3 days, or not double, or new under 80: nothing.
    expect(rising(fill(14, 1), [...fill(4, 12), ...fill(10, 0)])).toEqual([]);
    expect(rising(fill(14, 1), [...fill(3, 30), ...fill(11, 0)])).toEqual([]);
    expect(rising(fill(14, 3), [...fill(4, 20), ...fill(10, 0)])).toEqual([]);
    expect(rising(fill(14, 0), [...fill(5, 15), ...fill(9, 0)])).toEqual([]);
    expect(rising(fill(14, 0), [...fill(5, 16), ...fill(9, 0)])).toMatchObject([{ impressions: 80, before: 0 }]);
  });

  it("never fires for a search that only slipped under a day's cut: a missing row counts at the floor", () => {
    // Seen 7 days at 10 before; absent on 7 cut days whose floor is 10: at most 140 before, so 210 isn't double.
    const before = [...fill(7, 10), ...fill(7, 0)];
    const cut = [7, 8, 9, 10, 11, 12, 13];
    expect(rising(before, fill(14, 15))).toMatchObject([{ before: 70 }]);
    expect(rising(before, fill(14, 15), cut, 10)).toEqual([]);
    expect(rising(before, fill(14, 25), cut, 10)).toMatchObject([{ before: 140, atMost: true }]);
  });

  it("never fires for a steady search missing from cut days whose floor doesn't bound its impressions", () => {
    // Every day 600 one-click searches, plus a steady search with no clicks and 30 impressions a
    // day; on the recent days fewer of the others, so it makes the cut there. Before, it fell under
    // floors with a click, which say nothing of its impressions: its earlier figure is unknown.
    const steady = (bounded: boolean) => {
      const t = newTally(LAST_DAY, 14, 14);
      t.days.forEach((day, i) => {
        const filler = Array.from({ length: i < 14 ? 600 : 300 }, (_, j) => search(`made up filler ${j}`, 5, bounded && i < 14 ? 0 : 1));
        const cut = cutRows([...filler, search("steady widget query", 30, 0)]);
        addDay(t, { day, rows: cut.rows, rowsDropped: cut.rowsDropped, more: false, floor: cut.floor }, topicOf);
      });
      return (risingSearches(t) ?? []).filter((h) => h.label === "steady widget query");
    };
    expect(steady(false)).toEqual([]);
    // With floors of no clicks Google ranked the rest by impressions, so 5 a day bounds it: still not double.
    expect(steady(true)).toEqual([]);
    // Nor when Google had more rows than it sent: rows past them are in no fixed order.
    const t = newTally(LAST_DAY, 14, 14);
    t.days.forEach((day, i) => {
      const rows = i < 14 ? [] : [search("pet safe hanging plants", 20)];
      addDay(t, { day, rows, rowsDropped: 0, more: i < 14, floor: i < 14 ? null : null }, topicOf);
    });
    expect(risingSearches(t)).toEqual([]);
  });

  it("can't be checked without every day collected", () => {
    const t = newTally(LAST_DAY, 14, 14);
    addDay(t, { day: LAST_DAY, rows: [search("pet safe hanging plants", 500)], rowsDropped: 0, more: false, floor: null }, topicOf);
    expect(risingSearches(t)).toBeNull();
  });

  const losing = (before: number[], now: number[], cut: number[] = [], floor = 0) => {
    const t = newTally(LAST_DAY, 28, 28);
    t.days.forEach((day, i) => {
      const value = i < 28 ? before[i] : now[i - 28];
      const isCut = cut.includes(i);
      addDay(t, { day, rows: value ? [page("/care/fiddle-leaf-fig", value)] : [], rowsDropped: isCut ? 10 : 0, more: false, floor: isCut ? { searchClicks: floor, searchImpressions: floor * 20 } : null }, pageOf);
    });
    return losingPages(t);
  };

  it("finds a page losing clicks: 40 before, then down 40% and by 20 clicks", () => {
    expect(losing(fill(28, 2), [...fill(16, 2), ...fill(12, 0)])).toMatchObject([{ label: "/care/fiddle-leaf-fig", host: "fernhill.example", before: 56, clicks: 32 }]);
    // 39 before; or down only 39%; or down only 19 clicks: nothing.
    expect(losing([...fill(13, 3), ...fill(15, 0)], fill(28, 0))).toEqual([]);
    expect(losing([...fill(25, 4), ...fill(3, 0)], [...fill(30, 2)].slice(0, 28).map((_, i) => (i < 30 ? (i < 26 ? 2 : i < 27 ? 9 : 0) : 0)))).toEqual([]);
    expect(losing([...fill(20, 2), ...fill(8, 0)], [...fill(21, 1), ...fill(7, 0)])).toEqual([]);
  });

  it("counts a page's missing recent days at their floor, so a page that slipped under the cut doesn't fire", () => {
    const now = [...fill(10, 2), ...fill(18, 0)];
    const cut = Array.from({ length: 18 }, (_, k) => 28 + 10 + k);
    expect(losing(fill(28, 3), now)).toMatchObject([{ clicks: 20 }]);
    expect(losing(fill(28, 3), now, cut, 2)).toEqual([]);
  });

  it("finds questions within reach: position 5 to 20 and 100 impressions", () => {
    const row = (position: number, impressions: number) => ({ key: `q_${position}_${impressions}`, label: "water a monstera", m: { searchPosition: position, searchImpressions: impressions } });
    expect(withinReach({ rows: [row(5, 100), row(20, 500), row(4.9, 900), row(20.1, 900), row(11, 99)] }).map((h) => h.questionId)).toEqual(["q_20_500", "q_5_100"]);
  });
});

describe("looking at a connection", () => {
  it("writes each fired rule's row and a Review suggestion, as connector_signals with no person, expiring in 30 days", async () => {
    await topics();
    await pages();
    await questions();
    await rolledTopics();
    const r = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    expect(r).toMatchObject({ status: "detected", fired: { rising_search: 1, losing_page: 1, within_reach: 1 }, proposed: 3 });
    expect(r.checked.sort()).toEqual(["losing_page", "rising_search", "within_reach"]);
    const byRule = Object.fromEntries((await rows()).map((x) => [x.rule, x]));
    expect(byRule.rising_search).toMatchObject({ label: "pet safe hanging plants", numbers: { searchImpressions: 260, searchClicks: 13 }, before: { searchImpressions: 40 }, subjectId: "sub_pets00000000", shownIn: "review", round: 1 });
    expect(byRule.rising_search!.window).toEqual({ from: "2026-11-07", to: LAST_DAY, beforeFrom: "2026-10-24", beforeTo: "2026-11-06" });
    expect(byRule.losing_page).toMatchObject({ label: "/care/fiddle-leaf-fig", key: { page: "/care/fiddle-leaf-fig", host: "fernhill.example" }, numbers: { searchClicks: 41 }, before: { searchClicks: 96 } });
    expect(byRule.within_reach).toMatchObject({ questionId: "q_monstera000000000", question: "How often should I water a monstera?", numbers: { searchPosition: 8.6, searchImpressions: 1900 } });
    for (const row of (await rows())) expect(row.id).toMatch(DATA_SIGNAL_ID);
    const open = (await actions());
    expect(open).toHaveLength(3);
    for (const a of open) {
      expect(a).toMatchObject({ agent: "connector_signals", action: DATA_SIGNAL_ACTION, personId: null, state: "proposed", clearDetailsOnClose: true, review: { kind: "data_signal", href: SIGNALS_REVIEW_HREF }, requestedBy: { type: "system", id: "connector_signals" } });
      expect(a.target.type).toBe("data_signal");
      expect(Date.parse(a.expiresAt) - NOW.getTime()).toBe(30 * DAY);
      // The key names the signal and its round: never a week, a word or a path.
      expect(a.dedupeKey).toMatch(/^data_signal\.suggest\|dsg_[0-9a-f]{24}\|r1$/);
      expect(a.signals[0]).toEqual({ kind: "data_signal", ref: a.target.id });
      for (const s of a.signals.slice(1)) expect(s).toMatchObject({ kind: "metric", ref: `${ID}:${LAST_DAY}` });
      expect((await rows()).find((x) => x.id === a.target.id)!.agentActionId).toBe(a.id);
    }
    // The subject planning doc: the top searches near each decided subject.
    const subjects = db.raw("metric_snapshots", planningId(ID, 0, "search_performance", "subject"))!;
    expect(subjects.rows).toEqual([
      { key: "sub_water0000000", m: { nearbySearches: 1, searchImpressions: 840, searchClicks: 90 } },
      { key: "sub_pets00000000", m: { nearbySearches: 2, searchImpressions: 420, searchClicks: 13 } },
    ]);
    expect((await load()).collect!.detectedOn).toBe("2026-11-23");
  });

  it("maps a search to a subject at the cut-off of the store subject readers use, switch off and on (ADR-0023)", async () => {
    // Two different values, so detection wired to the other store's cut-off can't pass.
    const was = { ...NEAR_SUBJECT };
    Object.assign(NEAR_SUBJECT, { old: 0.75, new: 0.65 });
    onTestFinished(() => void Object.assign(NEAR_SUBJECT, was));
    // Every search sits at 0.7 from its subject: between the two.
    const between = mapView({ nearest: async (texts) => texts.map((t) => (t.includes("pet") ? { ref: "sub_pets00000000", sim: 0.7 } : t.includes("monstera") ? { ref: "sub_water0000000", sim: 0.7 } : null)) });
    const look = async () => {
      db = new FakeFirestore();
      await seedSearchConsole(A, db, ID);
      await topics();
      await rolledTopics();
      await detectConnection(A, await load(), [], { db, now: NOW, map: async () => between });
      const rising = (await rows()).find((x) => x.rule === "rising_search");
      const lines = (db.raw("metric_snapshots", planningId(ID, 0, "search_performance", "subject"))!.rows as Array<{ key: string }>).map((r) => r.key);
      return { subject: rising?.subjectId ?? null, lines };
    };

    // Off: brand_map_vectors' cut-off, which 0.7 doesn't reach.
    expect(await look()).toEqual({ subject: null, lines: [] });
    // On: brand search's, which it does.
    for (const k of ["SEARCH_INDEX_ENABLED", "SEARCH_FAMILY_INDEX_ENABLED", "SEARCH_SUBJECT_READS_ENABLED"]) vi.stubEnv(k, "true");
    expect(await look()).toEqual({ subject: "sub_pets00000000", lines: ["sub_water0000000", "sub_pets00000000"] });
  });

  it("leaves out a rising search the map already asks, in the same words or close in meaning", async () => {
    await topics();
    const same = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView({ hasWords: async (keys) => new Set(keys) }) });
    expect(same.fired.rising_search).toBe(0);
    const near = await detectConnection(A, await load(), [], {
      db,
      now: NOW,
      map: async () => mapView({ questionsOf: async () => ["Which hanging plants are safe for pets?"] }),
      embed: async (items) => items.map(() => [1, 0, 0]),
    });
    expect(near.fired.rising_search).toBe(0);
    // When meaning can't be had, a question with every meaningful word of the search answers it.
    const words = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView({ questionsOf: async () => ["Pet safe hanging plants for a sunny window"] }), embed: async (items) => items.map(() => null) });
    expect(words.fired.rising_search).toBe(0);
    expect((await actions())).toHaveLength(0);
  });

  it("adds Google Analytics sessions to a page losing clicks when that property feeds planning too", async () => {
    await pages();
    const GA = "dcn_gggggggggggggggggggg";
    await seedSearchConsole(A, db, GA, { connectorId: "google-analytics", label: "Google Analytics 4", account: "properties/123456789" });
    const ga = (await forTenant(A, db).dataConnections.getById(GA))!;
    for (let i = 0; i < 56; i++) {
      const day = addDays(LAST_DAY, i - 55);
      await putSnapshot(
        A,
        `${GA}_0_site_traffic_landing_${day}`,
        { connectionId: GA, gen: 0, account: ga.account, connectorId: "google-analytics", stream: "site_traffic", by: "landing", day, window: null, days: null, timeZone: "Europe/London", final: i < 50, totals: null, rows: [{ key: "/care/fiddle-leaf-fig", m: { ga4Sessions: i < 28 ? 4 : 2 } }], rowsSeen: 1, rowsDropped: 0, more: false, floor: null, basis: null, notes: [], collectedAt: NOW.toISOString(), ttlAt: ttlFor(day, 90) },
        { db },
      );
    }
    await detectConnection(A, await load(), [ga], { db, now: NOW, map: async () => mapView() });
    expect((await rows())[0]).toMatchObject({ rule: "losing_page", numbers: { searchClicks: 41, ga4Sessions: 56 }, before: { searchClicks: 96, ga4Sessions: 112 }, mayChange: true });
  });

  it("proposes at most 5 a day and 15 open at once, strongest first, and writes every row", async () => {
    await writeDays(A, db, ID, "topic", 28, (_day, i) => (i >= 14 ? Array.from({ length: 7 }, (_, k) => search(`pet search ${k}`, 10 + k)) : []));
    const r = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    expect(r.fired.rising_search).toBe(7);
    expect(r.proposed).toBe(CAPS.newPerDay);
    expect((await rows())).toHaveLength(7);
    const proposed = new Set((await actions()).map((a) => a.target.id));
    const strongest = (await rows()).sort((a, b) => b.numbers!.searchImpressions! - a.numbers!.searchImpressions!).slice(0, 5);
    expect(strongest.every((x) => proposed.has(x.id))).toBe(true);
    // The next day, with 5 open and 0 new today, 2 more; never past 15 open.
    const next = new Date(NOW.getTime() + DAY);
    expect((await detectConnection(A, await load(), [], { db, now: next, map: async () => mapView() })).proposed).toBe(2);
    expect(await listOpenAgentActions(A, { action: DATA_SIGNAL_ACTION, db, now: next.toISOString() })).toHaveLength(7);
  });

  it("proposes nothing new while a suggestion is open, nothing for 30 days after a dismissal, and a new round after", async () => {
    await pages();
    await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    const again = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + DAY), map: async () => mapView() });
    expect(again).toMatchObject({ proposed: 0, refreshed: 1 });
    const [a] = (await actions());
    await transitionAgentAction(A, a!.id, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_admin" }, at: NOW.toISOString(), clearDetails: true }, { db });
    await blankSignal(A, a!.target.id, { db, now: NOW, quietDays: 30 });
    expect((await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + 10 * DAY), map: async () => mapView() })).proposed).toBe(0);
    expect((await rows())[0]!.label).toBeNull();
    const later = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + 31 * DAY), map: async () => mapView() });
    expect(later.proposed).toBe(1);
    const round2 = (await actions()).find((x) => x.state === "proposed")!;
    expect(round2.dedupeKey).toMatch(/\|r2$/);
    expect((await rows())[0]).toMatchObject({ round: 2, agentActionId: round2.id, label: "/care/fiddle-leaf-fig" });
  });

  it("declines an open suggestion as stale when its rule was checked again and no longer holds", async () => {
    await pages();
    await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    // The page recovers: the same 56 days, with its last 28 days as busy as before.
    await writeDays(A, db, ID, "page", 56, () => [page("/care/fiddle-leaf-fig", 4)]);
    const r = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + DAY), map: async () => mapView() });
    expect(r).toMatchObject({ stale: 1, proposed: 0 });
    const [a] = (await actions());
    expect(a).toMatchObject({ state: "declined", declined: { reason: "stale" }, proposal: null, basis: null });
    expect((await rows())[0]).toMatchObject({ label: null, numbers: null, key: null });
  });

  it("looks only at a connection both members and Vizzy may read, with decided subjects on the map", async () => {
    await pages();
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(A, ID, () => ({ patch: { grants: [{ to: "members", can: "read" }] }, activity: [] }), db);
    expect(await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() })).toMatchObject({ status: "skipped", reason: "not_for_planning" });
    await changeDataConnection(A, ID, () => ({ patch: { grants: [{ to: "members", can: "read" }, { to: "agent:vizzy", can: "read" }] }, activity: [] }), db);
    expect(await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView({ subjects: 0 }) })).toMatchObject({ status: "skipped", reason: "no_subjects" });
    expect(await detectConnection(A, await load(), [], { db, now: NOW, map: async () => null })).toMatchObject({ status: "skipped", reason: "no_subjects" });
    expect((await rows())).toEqual([]);
  });

  it("checks no rule whose days aren't all collected: a page needs 56, a rising search 28", async () => {
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(A, ID, (cur) => ({ patch: { collect: { ...cur.collect!, backfilledTo: addDays(LAST_DAY, -33), filled: false } }, activity: [] }), db);
    await topics();
    await pages();
    const r = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    expect(r.checked).toEqual(["rising_search"]);
    expect(r.fired.losing_page).toBe(0);
  });
});

describe("with dates stored as Firestore stores them", () => {
  // Every Date is kept as a Timestamp and read back as one, as on Firestore: day docs, planning
  // docs and the rows' own time to live.
  beforeEach(async () => {
    db = timestampFirestore(new FakeFirestore());
    await seedSearchConsole(A, db, ID);
  });

  it("looks, refreshes, is dismissed, stays away 30 days and comes back as a new round", async () => {
    await topics();
    await pages();
    await questions();
    await rolledTopics();
    expect(await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() })).toMatchObject({ status: "detected", proposed: 3 });
    expect(db.dump("data_signals").every((d) => isStoredTimestamp(d.ttlAt))).toBe(true);
    expect(isStoredTimestamp(db.raw("metric_snapshots", planningId(ID, 0, "search_performance", "subject"))!.ttlAt)).toBe(true);
    const losing = (await rows()).find((x) => x.rule === "losing_page")!;
    expect(await dismissSignal(A, losing.id, { db, now: NOW })).toEqual({ ok: true, value: { dismissedUntil: new Date(NOW.getTime() + 30 * DAY).toISOString() } });
    const next = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + DAY), map: async () => mapView() });
    expect(next).toMatchObject({ status: "detected", proposed: 0, refreshed: 2 });
    expect((await rows()).find((x) => x.id === losing.id)).toMatchObject({ label: null, dismissedUntil: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    const later = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + 31 * DAY), map: async () => mapView() });
    expect(later.status).toBe("detected");
    expect((await rows()).find((x) => x.id === losing.id)).toMatchObject({ round: 2, label: "/care/fiddle-leaf-fig" });
    expect(db.dump("data_signals").every((d) => isStoredTimestamp(d.ttlAt))).toBe(true);
  });

  it("declines a suggestion that no longer holds and blanks its row", async () => {
    await pages();
    await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    await writeDays(A, db, ID, "page", 56, () => [page("/care/fiddle-leaf-fig", 4)]);
    expect(await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + DAY), map: async () => mapView() })).toMatchObject({ stale: 1, proposed: 0 });
    expect((await rows())[0]).toMatchObject({ label: null, numbers: null, dismissedUntil: null });
    expect(isStoredTimestamp(db.dump("data_signals")[0]!.ttlAt)).toBe(true);
  });
});

describe("a rising search on a map at any size", () => {
  beforeEach(() => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  });

  async function mapWithSubjects() {
    const { ensureMoved } = await import("@/lib/brandMap/move");
    const { createSubject } = await import("@/lib/brandMap/records");
    await ensureMoved(A, { db, nowMs: NOW.getTime() });
    const pets = await createSubject(A, { name: "Pet safe plants" }, { db, nowMs: NOW.getTime() });
    await createSubject(A, { name: "Watering houseplants" }, { db, nowMs: NOW.getTime() });
    return pets.ok ? pets.value.id : "";
  }

  it("is proposed as a question in the search's own words under its nearest subject, and counted on the brand map", async () => {
    const pets = await mapWithSubjects();
    await topics();
    const r = await detectConnection(A, await load(), [], { db, now: NOW, embed: async (items) => items.map(() => null) });
    expect(r).toMatchObject({ proposed: 1, fired: { rising_search: 1 } });
    const { brandMapRecords } = await import("@/lib/tenant/brandMapRecords");
    const [q] = (await brandMapRecords(A, db).find("q", { where: [["fromConnectionId", "==", ID]] })) as Array<Record<string, unknown>>;
    expect(q).toMatchObject({ text: "pet safe hanging plants", status: "proposed", from: "search_console", fromConnectionId: ID, subjectId: pets, reason: "260 impressions in the 14 days to 20 Nov, up from 40", evidence: "pet safe hanging plants" });
    const [a] = await actions();
    expect(a).toMatchObject({ agent: "connector_signals", action: "brand_map.propose_question", personId: null, review: null, target: { type: "brand_question", id: q!.ref }, clearDetailsOnClose: true });
    expect(a!.dedupeKey).toBe(`brand_map.propose_question|${String(q!.ref)}|r1`);
    expect((await rows())[0]).toMatchObject({ rule: "rising_search", shownIn: "brand_map", questionId: q!.ref, agentActionId: a!.id });
    const { proposalsWaiting } = await import("@/lib/brandMap/waiting");
    expect(await proposalsWaiting(A, { db })).toBe(1);
    // Never proposed again while it is on the map, in any state, words edited or not.
    const { editQuestion } = await import("@/lib/brandMap/records");
    await editQuestion(A, String(q!.ref), { baseRev: Number(q!.rev ?? 0), text: "Which hanging plants are safe for cats and dogs?" }, { db, nowMs: NOW.getTime() });
    const again = await detectConnection(A, await load(), [], { db, now: new Date(NOW.getTime() + DAY), embed: async (items) => items.map(() => null) });
    expect(again.proposed).toBe(0);
    expect(await brandMapRecords(A, db).find("q", { where: [["fromConnectionId", "==", ID]] })).toHaveLength(1);
  });

  it("goes to Review instead with the map's scale switch off", async () => {
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    await topics();
    const r = await detectConnection(A, await load(), [], { db, now: NOW, map: async () => mapView() });
    expect(r.proposed).toBe(1);
    expect((await actions())[0]).toMatchObject({ action: DATA_SIGNAL_ACTION, target: { type: "data_signal" } });
    expect((await rows())[0]).toMatchObject({ shownIn: "review", questionId: null });
  });
});
