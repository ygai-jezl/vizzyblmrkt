import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { isStoredTimestamp, timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CollectStateSchema, type ConnectionGrant, type DataConnection } from "@/lib/types/dataConnection";
import type { SnapshotBasis, SnapshotNote, SnapshotRow } from "@/lib/types/metricSnapshot";
import type { ConnectorActor } from "./grants";
import { olderDaysNote } from "./handlers/cloudflare";
import { THRESHOLD_NOTE } from "./handlers/googleAnalytics";
import { accessLostMessage } from "./messages";
import {
  agentCollectedNumbers,
  CUT_ROWS_NOTE,
  fillingNote,
  missingNote,
  MIXED_BASIS_NOTE,
  NOT_COLLECTED_YET,
  NOT_ROLLED_YET,
  notFinalNote,
  notInYetNote,
  PAGE_NEEDS_GROUPING,
  pageNotKeptNote,
  peopleNote,
  rangeTooLong,
  rowKeyOf,
  SESSIONS_SUM_NOTE,
  startsNote,
  STREAM_NOT_COLLECTED,
} from "./numbers";
import { MERGED_NOTE } from "./handlers/searchConsole";
import { deleteSnapshot } from "./snapshots";
import { snapshotId } from "./keys";
import { addDays } from "./period";
import { rollConnection } from "./rollups";
import { TTL_MARGIN_DAYS, writeDayDoc, type SnapshotOwner } from "./snapshots";

// Collected numbers as Vizzy reads them, below the route: made-up numbers for made-up sites, read
// only by id from the brand's own snapshots. No provider is ever called (there is no transport).
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "agent", userId: "usr_x", role: "admin" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "agent", userId: "usr_y", role: "admin" };
const forAdmin: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "admin" };
const forMember: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "member" };
const VIZZY: ConnectionGrant[] = [{ to: "agent:vizzy", can: "read" }];
const T0 = "2026-11-01T10:00:00.000Z";
// 02:00 in Pacific time and 10:00 in London and UTC, on 23 Nov.
const NOW = new Date("2026-11-23T10:00:00.000Z");

const SC = "dcn_aaaaaaaaaaaaaaaaaaaa";
const GA = "dcn_bbbbbbbbbbbbbbbbbbbb";
const CF = "dcn_cccccccccccccccccccc";
const THEIRS = "dcn_dddddddddddddddddddd";
const FRESH = "dcn_eeeeeeeeeeeeeeeeeeee";

const SC_STREAM = "search_performance";
const GA_STREAM = "site_traffic";
const CF_STREAM = "zone_daily";

let db: FakeFirestore;

type Seed = { connectorId: string; account: string; collect?: Partial<DataConnection["collect"]> | null; grants?: ConnectionGrant[]; status?: "connected" | "disconnected"; health?: DataConnection["health"]; pausedAt?: string | null };

async function seed(ctx: TenantContext, id: string, s: Seed) {
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: s.connectorId,
      method: s.connectorId === "cloudflare" ? "token_fields" : "share_access",
      label: `Made up ${id.slice(-4)}`,
      account: s.account,
      ownerUid: "usr_admin",
      grants: s.grants ?? VIZZY,
      secrets: {},
      health: s.health ?? { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: s.pausedAt ?? null,
      pausedBy: s.pausedAt ? "usr_admin" : null,
      status: s.status ?? "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: s.status === "disconnected" ? T0 : null,
      ...(s.collect === null ? {} : { collect: CollectStateSchema.parse({ gen: 0, ...(s.collect ?? {}) }) }),
    },
    [{ kind: "connected", by: "usr_admin", at: T0 }],
    db,
  );
}

const ownerOf = (id: string, connectorId: string, account: string): SnapshotOwner => ({ id, connectorId, account, gen: 0 });

/** Search Console: 40 final days to 20 Nov, with two hosts for one page and a merged row on the last day. */
async function searchConsole(ctx = A, id = SC) {
  const owner = ownerOf(id, "search-console", "sc-domain:example.com");
  for (let i = 0; i < 40; i++) {
    const day = addDays("2026-11-20", -i);
    const base = { owner, stream: SC_STREAM, day, timeZone: "America/Los_Angeles", final: true, more: false, keepDays: 90 };
    await writeDayDoc(ctx, { ...base, by: "day", totals: { searchClicks: 10, searchImpressions: 200, searchCtr: 0.05, searchPosition: 6 + (i % 2) * 2 }, rows: [] }, { db, now: NOW });
    await writeDayDoc(
      ctx,
      {
        ...base,
        by: "page",
        totals: null,
        rows: [
          { key: "/pricing", host: "example.com", m: { searchClicks: 3, searchImpressions: 40, searchCtr: 0.075, searchPosition: 4, ...(i === 0 ? { merged: 2 } : {}) } },
          { key: "/pricing", host: "www.example.com", m: { searchClicks: 1, searchImpressions: 10, searchCtr: 0.1, searchPosition: 9 } },
          { key: "/blog/made-up-post", host: "example.com", m: { searchClicks: 2, searchImpressions: 50, searchCtr: 0.04, searchPosition: 12 } },
        ],
      },
      { db, now: NOW },
    );
    const topic: SnapshotRow[] = [{ key: "share of voice tool", m: { searchClicks: 2, searchImpressions: 30, searchCtr: 2 / 30, searchPosition: 11 } }];
    // A search seen only on the newer days, below the cut on a day whose rows were cut.
    if (i < 3) topic.push({ key: "made up search", m: { searchClicks: 1, searchImpressions: 20, searchCtr: 0.05, searchPosition: 14 } });
    await writeDayDoc(ctx, { ...base, by: "topic", totals: null, rows: topic, more: i === 5 }, { db, now: NOW });
  }
  await rollConnection(
    ctx,
    { owner, stream: SC_STREAM, by: ["day", "page", "topic"], keepDays: 90, lastDay: "2026-11-20", backfilledTo: "2026-10-12", timeZone: "America/Los_Angeles" },
    { db, now: NOW },
  );
  return { lastDay: "2026-11-20", finalThrough: "2026-11-20", backfilledTo: "2026-10-12", filled: false, timeZone: "America/Los_Angeles", rolledOn: "2026-11-23" };
}

/** Google Analytics: a property in London time, filling, 10 days to 21 Nov, final to 15 Nov. */
async function analytics() {
  const owner = ownerOf(GA, "google-analytics", "properties/1234");
  for (let i = 0; i < 10; i++) {
    const day = addDays("2026-11-21", -i);
    const notes: SnapshotNote[] = day === "2026-11-20" ? ["thresholded"] : [];
    const base = { owner, stream: GA_STREAM, day, timeZone: "Europe/London", final: day <= "2026-11-15", more: false, keepDays: 90, notes };
    await writeDayDoc(A, { ...base, by: "day", totals: { ga4Sessions: 100, ga4ActiveUsers: 80, ga4Views: 300, ga4KeyEvents: 5 }, rows: [] }, { db, now: NOW });
    await writeDayDoc(A, { ...base, by: "page", totals: null, rows: [{ key: "/pricing", m: { ga4Views: 90, ga4ActiveUsers: 30, ga4KeyEvents: 3 } }] }, { db, now: NOW });
    await writeDayDoc(
      A,
      {
        ...base,
        by: "landing",
        totals: null,
        rows: [
          { key: "/", m: { ga4Sessions: 60, ga4ActiveUsers: 50, ga4KeyEvents: 2 } },
          { key: "/pricing", m: { ga4Sessions: 20, ga4ActiveUsers: 15, ga4KeyEvents: 3 } },
        ],
      },
      { db, now: NOW },
    );
  }
  await rollConnection(A, { owner, stream: GA_STREAM, by: ["day", "page", "landing"], keepDays: 90, lastDay: "2026-11-21", backfilledTo: "2026-11-12", timeZone: "Europe/London" }, { db, now: NOW });
  return { lastDay: "2026-11-21", finalThrough: "2026-11-15", backfilledTo: "2026-11-12", filled: false, timeZone: "Europe/London", rolledOn: "2026-11-23" };
}

/** Cloudflare: 40 UTC days to 21 Nov, end users for the newest 31, all traffic before. */
async function cloudflare() {
  const owner = ownerOf(CF, "cloudflare", "0123456789abcdef0123456789abcdef");
  for (let i = 0; i < 40; i++) {
    const day = addDays("2026-11-21", -i);
    const basis: SnapshotBasis = i < 31 ? "end_users" : "all_traffic";
    const totals: Record<string, number> = basis === "end_users" ? { cfRequests: 1000, cfPageViews: 100, cfVisits: 40, cfUniqueVisitors: 30 } : { cfRequests: 2000, cfPageViews: 150, cfUniqueVisitors: 35 };
    await writeDayDoc(A, { owner, stream: CF_STREAM, by: "day", day, timeZone: "UTC", final: true, more: false, keepDays: 90, totals, rows: [], basis }, { db, now: NOW });
  }
  await rollConnection(A, { owner, stream: CF_STREAM, by: ["day"], keepDays: 90, lastDay: "2026-11-21", backfilledTo: "2026-10-13", timeZone: "UTC" }, { db, now: NOW });
  return { lastDay: "2026-11-21", finalThrough: "2026-11-21", backfilledTo: "2026-10-13", filled: false, timeZone: "UTC", rolledOn: "2026-11-23" };
}

const ask = (body: Record<string, unknown>, actor: ConnectorActor = forAdmin, ctx = A) => agentCollectedNumbers(ctx, actor, body, { db, now: NOW });

/** Every number in an answer has its meaning, word for word, and nothing else is explained. */
function explainsEveryNumber(body: Record<string, unknown>) {
  const keys = [...numberKeys(body)];
  const meanings = body.meanings as Record<string, unknown>;
  for (const k of keys) expect(meanings[k], k).toEqual(MEANINGS[k as keyof typeof MEANINGS]);
  expect(Object.keys(meanings).sort()).toEqual(keys.sort());
}

beforeEach(async () => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
  await seed(A, SC, { connectorId: "search-console", account: "sc-domain:example.com", collect: await searchConsole() });
  await seed(A, GA, { connectorId: "google-analytics", account: "properties/1234", collect: await analytics() });
  await seed(A, CF, { connectorId: "cloudflare", account: "0123456789abcdef0123456789abcdef", collect: await cloudflare() });
});
afterEach(() => vi.unstubAllEnvs());

describe("collected numbers for Vizzy", () => {
  it("reads the last 28 days from the rolled docs, by id only, every number with its meaning", async () => {
    const ops: string[] = [];
    const r = await agentCollectedNumbers(A, forAdmin, { connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "topic" }, { db: shapeRecordingFirestore(db, ops), now: NOW });
    expect(r.status).toBe(200);
    expect(ops).toEqual([]);
    const body = r.body;
    expect(body.connection).toEqual({ id: SC, connectorId: "search-console", connector: "Google Search Console", label: `Made up ${SC.slice(-4)}` });
    expect(body.period).toEqual({ from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-20", words: "24 Oct to 20 Nov 2026, Pacific time" });
    expect(body.lag).toBe("Search Console finishes a day 2 to 3 days later.");
    expect(body.lagDays).toBe(3);
    // Totals from the day grouping: counts added, click rate worked out again, position weighted.
    expect(body.totals).toEqual({ searchClicks: 280, searchImpressions: 5600, searchCtr: 0.05, searchPosition: 7 });
    // Searches come back under `query`, as a live read names them.
    expect(body.rows).toEqual([
      { query: "share of voice tool", searchClicks: 56, searchImpressions: 840, searchCtr: 56 / 840, searchPosition: 11 },
      { query: "made up search", searchClicks: 3, searchImpressions: 60, searchCtr: 0.05, searchPosition: 14 },
    ]);
    expect(body.rowsDropped).toBe(0);
    // "made up search" was missing on 15 Nov, whose rows were cut, so it may run a little low.
    expect(body.notes).toEqual([notInYetNote("2026-11-21", "2026-11-22"), CUT_ROWS_NOTE]);
    expect(body.notes).toContain("21 and 22 Nov aren't in these numbers yet.");
    expect(JSON.stringify(body.rows)).not.toContain("cutDays");
    explainsEveryNumber(body);
    expect(Object.keys(body.meanings as object)).toEqual(expect.arrayContaining(["lagDays", "rowsDropped", "searchClicks"]));
  });

  it("reads yesterday and the last 7 days from the day docs, ending on the last collected day", async () => {
    const one = (await ask({ connectionId: SC, stream: SC_STREAM, period: "yesterday", by: "page" })).body;
    expect(one.period).toMatchObject({ from: "2026-11-20", to: "2026-11-20", words: "20 Nov 2026, Pacific time" });
    // One day's rows as kept: each host apart, with how many addresses a row adds up.
    expect(one.rows).toEqual([
      { page: "/pricing", host: "example.com", searchClicks: 3, searchImpressions: 40, searchCtr: 0.075, searchPosition: 4, merged: 2 },
      { page: "/blog/made-up-post", host: "example.com", searchClicks: 2, searchImpressions: 50, searchCtr: 0.04, searchPosition: 12 },
      { page: "/pricing", host: "www.example.com", searchClicks: 1, searchImpressions: 10, searchCtr: 0.1, searchPosition: 9 },
    ]);
    expect(one.totals).toEqual({ searchClicks: 10, searchImpressions: 200, searchCtr: 0.05, searchPosition: 6 });
    explainsEveryNumber(one);

    const week = (await ask({ connectionId: SC, stream: SC_STREAM, period: "last_7_days" })).body;
    expect(week.period).toMatchObject({ from: "2026-11-14", to: "2026-11-20" });
    expect((week.rows as Array<{ day: string }>).map((r) => r.day)).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(week.totals).toMatchObject({ searchClicks: 70, searchImpressions: 1400, searchCtr: 0.05 });
    explainsEveryNumber(week);
  });

  it("adds a page's days together, counting cut days, and keeps the top rows", async () => {
    const week = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-10", to: "2026-11-20", by: "topic", limit: 1 })).body;
    expect(week.rows).toEqual([{ query: "share of voice tool", searchClicks: 22, searchImpressions: 330, searchCtr: 22 / 330, searchPosition: 11 }]);
    expect(week.rowsDropped).toBe(1);
    // "made up search" was missing on 15 Nov, whose rows were cut, so it may have been below the floor.
    const both = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-10", to: "2026-11-20", by: "topic" })).body;
    expect((both.rows as Array<{ query: string }>).map((r) => r.query)).toEqual(["share of voice tool", "made up search"]);
    expect(both.notes).toContain(CUT_ROWS_NOTE);
    // Explicit days that end before the last collected day say nothing about later days.
    const earlier = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-10", to: "2026-11-19", by: "topic" })).body;
    expect((earlier.notes as string[]).some((n) => n.includes("in these numbers yet"))).toBe(false);
    const toLast = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-18", to: "2026-11-20" })).body;
    expect(toLast.notes).toEqual([notInYetNote("2026-11-21", "2026-11-22")]);
  });

  it("leaves counts of people empty over more than one day, in totals and rows, and keeps one day's", async () => {
    const landing = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "landing" })).body;
    expect(landing.period).toMatchObject({ from: "2026-11-15", to: "2026-11-21", timeZone: "Europe/London" });
    expect(landing.rows).toEqual([
      { landing: "/", ga4Sessions: 420, ga4ActiveUsers: null, ga4KeyEvents: 14 },
      { landing: "/pricing", ga4Sessions: 140, ga4ActiveUsers: null, ga4KeyEvents: 21 },
    ]);
    expect(landing.totals).toEqual({ ga4Sessions: 700, ga4ActiveUsers: null, ga4Views: 2100, ga4KeyEvents: 35 });
    expect(landing.notes).toContain(peopleNote(["ga4ActiveUsers"], false));
    expect(landing.notes).toContain("Analytics active users can't be added across days, so it is empty here. Read live for the whole period's figure.");
    expect(Object.keys(landing.meanings as object)).not.toContain("ga4ActiveUsers");
    explainsEveryNumber(landing);

    // By day, each row is one day, so it keeps that day's people.
    const days = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "day" })).body;
    expect((days.rows as Array<Record<string, unknown>>)[0]).toEqual({ day: "2026-11-15", ga4Sessions: 100, ga4ActiveUsers: 80, ga4Views: 300, ga4KeyEvents: 5 });
    expect(days.totals).toMatchObject({ ga4ActiveUsers: null });
    expect(days.notes).toContain(peopleNote(["ga4ActiveUsers"], true));

    const one = (await ask({ connectionId: GA, stream: GA_STREAM, period: "yesterday", by: "landing" })).body;
    expect(one.rows).toEqual([
      { landing: "/", ga4Sessions: 60, ga4ActiveUsers: 50, ga4KeyEvents: 2 },
      { landing: "/pricing", ga4Sessions: 20, ga4ActiveUsers: 15, ga4KeyEvents: 3 },
    ]);
    expect(one.totals).toEqual({ ga4Sessions: 100, ga4ActiveUsers: 80, ga4Views: 300, ga4KeyEvents: 5 });
    expect((one.notes as string[]).some((n) => n.includes("can't be added across days"))).toBe(false);
    explainsEveryNumber(one);
  });

  it("says which days may still change, what Google held back, and how far a filling period reaches", async () => {
    const week = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "page" })).body;
    expect(week.notes).toContain(notFinalNote("2026-11-16", "2026-11-21"));
    expect(week.notes).toContain("Numbers for 16 to 21 Nov may still change a little, until they are read again a week after each day.");
    expect(week.notes).toContain(THRESHOLD_NOTE);
    expect(week.notes).toContain("22 Nov isn't in these numbers yet.");

    const month = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_28_days", by: "landing" })).body;
    expect(month.period).toMatchObject({ from: "2026-11-12", to: "2026-11-21", finalThrough: "2026-11-15" });
    expect(month.notes).toContain(fillingNote("2026-11-12", 10, 28));
    expect(month.notes).toContain("Collected numbers start on 12 Nov, so this period covers 10 of its 28 days.");
    expect(month.notes).toContain(notFinalNote("2026-11-16", "2026-11-21"));
  });

  it("says when collecting stopped and why, instead of the days not in yet", async () => {
    await seed(A, FRESH, {
      connectorId: "google-analytics",
      account: "properties/1234",
      collect: { lastDay: "2026-11-18", finalThrough: "2026-11-15", backfilledTo: "2026-11-12", timeZone: "Europe/London" },
      health: { state: "broken", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: "share_access_lost", failures: 3, pausedUntil: null, since: "2026-11-19T06:00:00.000Z" },
    });
    // Its own day docs: the same made-up property under another connection.
    for (const day of ["2026-11-17", "2026-11-18"]) {
      await writeDayDoc(A, { owner: ownerOf(FRESH, "google-analytics", "properties/1234"), stream: GA_STREAM, by: "day", day, timeZone: "Europe/London", final: false, more: false, keepDays: 90, totals: { ga4Sessions: 10 }, rows: [] }, { db, now: NOW });
    }
    const body = (await ask({ connectionId: FRESH, stream: GA_STREAM, period: "last_7_days" })).body;
    expect(body.period).toMatchObject({ to: "2026-11-18" });
    expect(body.notes).toContain(`Collecting has stopped, so these numbers end on 18 Nov. ${accessLostMessage("2026-11-19T06:00:00.000Z")}`);
    expect((body.notes as string[]).some((n) => n.includes("aren't in these numbers yet"))).toBe(false);
  });

  it("caps explicit days at the last collected day, and starts them at the oldest kept", async () => {
    const capped = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-18", to: "2026-11-22" })).body;
    expect(capped.period).toMatchObject({ from: "2026-11-18", to: "2026-11-20" });
    expect(capped.notes).toContain("Google Search Console numbers are collected to 20 Nov, so this read ends there.");
    expect(capped.notes).toContain(notInYetNote("2026-11-21", "2026-11-22"));

    const none = await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-21", to: "2026-11-22" });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ rows: [], totals: null, rowsDropped: 0, notes: ["Nothing is collected for 21 and 22 Nov yet. The last collected day is 20 Nov."] });
    explainsEveryNumber(none.body);

    const early = (await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-10-05", to: "2026-10-15" })).body;
    expect(early.period).toMatchObject({ from: "2026-10-12", to: "2026-10-15" });
    expect(early.notes).toContain(startsNote("2026-10-12"));
    expect(early.notes).toContain("Collected numbers start on 12 Oct, so this starts there. Read live for earlier days.");
    expect(early.rows).toHaveLength(4);

    const gone = await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-10-01", to: "2026-10-05" });
    expect(gone.body).toMatchObject({ rows: [], notes: [startsNote("2026-10-12")] });
  });

  it("refuses explicit days by page, search or landing page over 14 days, and by day over the days kept", async () => {
    const long = await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-06", to: "2026-11-20", by: "page" });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: "range_too_long", message: rangeTooLong("page", 14) });
    expect(long.body.message).toBe("Explicit days by page can span at most 14 days. For longer, ask for the last 28 or 90 days.");
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-07", to: "2026-11-20", by: "page" })).status).toBe(200);
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-01", to: "2026-11-20", by: "topic" })).body).toMatchObject({ error: "range_too_long" });
    expect((await ask({ connectionId: GA, stream: GA_STREAM, from: "2026-11-01", to: "2026-11-20", by: "landing" })).status).toBe(400);
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-08-23", to: "2026-11-20" })).status).toBe(200);
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-08-22", to: "2026-11-20" })).body).toMatchObject({ error: "range_too_long" });
    // Never past today in the provider's zone, nor backwards.
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-20", to: "2026-11-24" })).body).toEqual({ error: "bad_dates" });
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-11-20", to: "2026-11-19" })).body).toEqual({ error: "bad_dates" });
    expect((await ask({ connectionId: SC, stream: SC_STREAM, from: "2026-02-30", to: "2026-03-01" })).body).toEqual({ error: "bad_dates" });
  });

  it("reads one page by page, its hosts apart and no site totals, and says when it isn't kept", async () => {
    const page = (await ask({ connectionId: SC, stream: SC_STREAM, period: "last_90_days", by: "page", page: "/pricing" })).body;
    expect(page.rows).toEqual([
      // The most addresses any one day added together for it stays on the row.
      { page: "/pricing", host: "example.com", searchClicks: 120, searchImpressions: 1600, searchCtr: 0.075, searchPosition: 4, merged: 2 },
      { page: "/pricing", host: "www.example.com", searchClicks: 40, searchImpressions: 400, searchCtr: 0.1, searchPosition: 9 },
    ]);
    expect(page.totals).toBeNull();
    expect(page.period).toMatchObject({ from: "2026-10-12", to: "2026-11-20" });
    explainsEveryNumber(page);

    const missing = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "landing", page: "/nowhere" })).body;
    expect(missing.rows).toEqual([]);
    expect(missing.notes).toContain(pageNotKeptNote("/nowhere", "landing"));

    const byDay = await ask({ connectionId: SC, stream: SC_STREAM, period: "last_7_days", page: "/pricing" });
    expect(byDay.status).toBe(400);
    expect(byDay.body).toEqual({ error: "page_needs_grouping", message: PAGE_NEEDS_GROUPING });
  });

  it("names the days Cloudflare counted all traffic", async () => {
    const recent = (await ask({ connectionId: CF, stream: CF_STREAM, period: "last_7_days" })).body;
    expect((recent.notes as string[]).some((n) => n.includes("all traffic"))).toBe(false);
    expect(recent.totals).toEqual({ cfRequests: 7000, cfPageViews: 700, cfVisits: 280, cfUniqueVisitors: null });
    expect(recent.notes).toContain(peopleNote(["cfUniqueVisitors"], true));

    const older = (await ask({ connectionId: CF, stream: CF_STREAM, from: "2026-10-13", to: "2026-10-25" })).body;
    expect(older.notes).toContain(olderDaysNote("2026-10-13", "2026-10-21"));
    // A visits total needs every day's visits.
    expect(older.totals).toMatchObject({ cfVisits: null });

    const month = (await ask({ connectionId: CF, stream: CF_STREAM, period: "last_90_days" })).body;
    expect(month.notes).toContain(MIXED_BASIS_NOTE);
    expect(month.rows).toHaveLength(40);
    expect(month.rowsDropped).toBe(0);
    const latest = (await ask({ connectionId: CF, stream: CF_STREAM, period: "last_90_days", limit: 3 })).body;
    expect((latest.rows as Array<{ day: string }>).map((r) => r.day)).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(latest.rowsDropped).toBe(37);
  });

  it("logs each read as Vizzy's, off the recent list, leaving health and updatedAt alone", async () => {
    const before = db.raw("data_connections", SC) as unknown as DataConnection;
    await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "page", limit: 5 });
    const rows = db.dump("data_connection_activity").filter((a) => a.connectionId === SC && a.kind === "read");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      by: "agent:vizzy",
      code: "collected",
      read: { stream: SC_STREAM, by: "page", from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", limit: 5, period: "last_28_days", pageFilter: false },
    });
    expect(JSON.stringify(rows[0])).not.toContain("/pricing");
    const after = db.raw("data_connections", SC) as unknown as DataConnection;
    expect(after.recent).toEqual(before.recent);
    expect(after.health).toEqual(before.health);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("says a page row adds Search Console addresses together, over one day and over several", async () => {
    const one = (await ask({ connectionId: SC, stream: SC_STREAM, period: "yesterday", by: "page" })).body;
    expect(one.notes).toContain(MERGED_NOTE);
    const week = (await ask({ connectionId: SC, stream: SC_STREAM, period: "last_7_days", by: "page" })).body;
    expect(week.rows).toContainEqual(expect.objectContaining({ page: "/pricing", host: "example.com", merged: 2 }));
    expect(week.notes).toContain(MERGED_NOTE);
    const rolled = (await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "page" })).body;
    expect(rolled.notes).toContain(MERGED_NOTE);
    explainsEveryNumber(rolled);
  });

  it("says sessions over several days add each day's, and not for one day", async () => {
    const week = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "landing" })).body;
    expect(week.notes).toContain(SESSIONS_SUM_NOTE);
    const month = (await ask({ connectionId: GA, stream: GA_STREAM, period: "last_28_days" })).body;
    expect(month.notes).toContain(SESSIONS_SUM_NOTE);
    const one = (await ask({ connectionId: GA, stream: GA_STREAM, period: "yesterday", by: "landing" })).body;
    expect(one.notes).not.toContain(SESSIONS_SUM_NOTE);
  });

  it("says how many days a rolled period is missing, so its sums are never silently short", async () => {
    const owner = ownerOf(SC, "search-console", "sc-domain:example.com");
    for (const by of ["day", "page", "topic"] as const) await deleteSnapshot(A, snapshotId(SC, 0, SC_STREAM, by, "2026-11-01"), { db });
    await rollConnection(A, { owner, stream: SC_STREAM, by: ["day", "page", "topic"], keepDays: 90, lastDay: "2026-11-20", backfilledTo: "2026-10-12", timeZone: "America/Los_Angeles" }, { db, now: NOW });
    const body = (await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days" })).body;
    expect(body.notes).toContain(missingNote(1));
    expect(body.totals).toMatchObject({ searchClicks: 270 });
    expect(TTL_MARGIN_DAYS).toBeGreaterThan(0);
  });

  it("writes every note in house style", async () => {
    const notes = [
      NOT_COLLECTED_YET,
      NOT_ROLLED_YET,
      STREAM_NOT_COLLECTED,
      PAGE_NEEDS_GROUPING,
      MIXED_BASIS_NOTE,
      CUT_ROWS_NOTE,
      SESSIONS_SUM_NOTE,
      missingNote(1),
      missingNote(3),
      rangeTooLong("day", 90),
      rangeTooLong("landing", 14),
      peopleNote(["ga4ActiveUsers", "cfUniqueVisitors"], true),
      notFinalNote("2026-11-16", "2026-11-21"),
      fillingNote("2026-10-18", 34, 90),
      pageNotKeptNote("/pricing", "page"),
    ];
    for (const n of notes) {
      expect(dashesIn(n), n).toEqual([]);
      expect(aiTellsIn(n), n).toEqual([]);
    }
  });
});

describe("who may read collected numbers", () => {
  it("refuses another brand's connection, a disconnected one, and a reader without the grants", async () => {
    await seed(B, THEIRS, { connectorId: "search-console", account: "sc-domain:example.com", collect: await searchConsole(B, THEIRS), grants: [...VIZZY, { to: "members", can: "read" }] });
    expect((await ask({ connectionId: THEIRS, stream: SC_STREAM, period: "last_28_days" })).status).toBe(404);
    expect((await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days" }, forAdmin, B)).status).toBe(404);

    await seed(A, FRESH, { connectorId: "search-console", account: "sc-domain:example.com", collect: { lastDay: "2026-11-20", backfilledTo: "2026-10-12" }, status: "disconnected" });
    const gone = await ask({ connectionId: FRESH, stream: SC_STREAM, period: "last_7_days" });
    expect(gone.status).toBe(409);
    expect(gone.body).toMatchObject({ error: "disconnected", message: "This connection was disconnected. Connect again to read its numbers." });

    const member = await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days" }, forMember);
    expect(member.status).toBe(403);
    expect(member.body).toMatchObject({ error: "no_read_grant" });
    expect(db.dump("data_connection_activity").filter((a) => a.kind === "read")).toEqual([]);
  });

  it("refuses a connection Vizzy isn't allowed to read", async () => {
    await seed(A, FRESH, { connectorId: "search-console", account: "sc-domain:example.com", collect: { lastDay: "2026-11-20", backfilledTo: "2026-10-12" }, grants: [] });
    const r = await ask({ connectionId: FRESH, stream: SC_STREAM, period: "last_7_days" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "no_agent_grant" });
  });

  it("refuses what the stream doesn't collect, and says when nothing is collected or added up yet", async () => {
    expect((await ask({ connectionId: SC, stream: "nope_stream", period: "last_7_days" })).body).toEqual({ error: "unknown_stream" });
    expect((await ask({ connectionId: CF, stream: CF_STREAM, period: "last_7_days", by: "page" })).body).toEqual({ error: "by_not_allowed" });
    expect((await ask({ connectionId: CF, stream: CF_STREAM, period: "last_7_days", by: "day", page: "/pricing" })).body).toEqual({ error: "page_not_allowed" });

    await seed(A, FRESH, { connectorId: "search-console", account: "sc-domain:example.com", collect: null });
    expect((await ask({ connectionId: FRESH, stream: SC_STREAM, period: "last_7_days" })).body).toEqual({ error: "not_collected_yet", message: NOT_COLLECTED_YET });
    // Days collected, but not yet added up into the 28 and 90 day docs.
    const unrolled = "dcn_ffffffffffffffffffff";
    await seed(A, unrolled, { connectorId: "search-console", account: "sc-domain:example.com", collect: { lastDay: "2026-11-20", backfilledTo: "2026-11-20" } });
    expect((await ask({ connectionId: unrolled, stream: SC_STREAM, period: "last_28_days" })).body).toEqual({ error: "not_ready", message: NOT_ROLLED_YET });
    // A roll that stopped half way: the day grouping's 28 days are newer than the pages'.
    const owner = { id: SC, connectorId: "search-console", account: "sc-domain:example.com", gen: 0 };
    await writeDayDoc(A, { owner, stream: SC_STREAM, by: "day", day: "2026-11-21", timeZone: "America/Los_Angeles", final: true, more: false, keepDays: 90, totals: { searchClicks: 1 }, rows: [] }, { db, now: NOW });
    await rollConnection(A, { owner, stream: SC_STREAM, by: ["day"], keepDays: 90, lastDay: "2026-11-21", backfilledTo: "2026-10-12", timeZone: "America/Los_Angeles" }, { db, now: NOW });
    expect((await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "page" })).body).toEqual({ error: "not_ready", message: NOT_ROLLED_YET });
    expect((await ask({ connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "day" })).status).toBe(200);

    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "false");
    expect((await ask({ connectionId: CF, stream: CF_STREAM, period: "last_7_days" })).body).toEqual({ error: "connector_off" });
  });

  it("400s bad input, including a brand in the body", async () => {
    const bad = [
      { connectionId: "nope", stream: SC_STREAM, period: "last_7_days" },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days", tenantId: "ten_b" },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days", limit: 500 },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days", from: "2026-11-01", to: "2026-11-02" },
      { connectionId: SC, stream: SC_STREAM, period: "last_week" },
      { connectionId: SC, stream: SC_STREAM },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days", by: "weekly" },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days", by: "page", page: "pricing" },
    ];
    for (const b of bad) expect((await ask(b)).body, JSON.stringify(b)).toEqual({ error: "invalid_input" });
    expect((await agentCollectedNumbers(A, forAdmin, undefined, { db, now: NOW })).status).toBe(400);
  });

  it("names searches by the stream's own key", () => {
    expect(rowKeyOf({ joins: { day: "day", page: "page", query: "topic" } }, "topic")).toBe("query");
    expect(rowKeyOf({ joins: { day: "day", landing: "page" } }, "landing")).toBe("landing");
  });
});

describe("collected numbers stored as Firestore stores them", () => {
  it("answers the same when every stored time to live reads back as a Timestamp", async () => {
    const asks = [
      { connectionId: SC, stream: SC_STREAM, period: "last_28_days", by: "topic" },
      { connectionId: SC, stream: SC_STREAM, period: "last_7_days" },
      { connectionId: SC, stream: SC_STREAM, from: "2026-11-10", to: "2026-11-20", by: "page" },
      { connectionId: GA, stream: GA_STREAM, period: "last_7_days", by: "landing" },
      { connectionId: CF, stream: CF_STREAM, period: "last_90_days" },
    ];
    const plain = [];
    for (const body of asks) plain.push(await ask(body));
    db = timestampFirestore(new FakeFirestore());
    await seed(A, SC, { connectorId: "search-console", account: "sc-domain:example.com", collect: await searchConsole() });
    await seed(A, GA, { connectorId: "google-analytics", account: "properties/1234", collect: await analytics() });
    await seed(A, CF, { connectorId: "cloudflare", account: "0123456789abcdef0123456789abcdef", collect: await cloudflare() });
    expect(db.dump("metric_snapshots").every((d) => isStoredTimestamp(d.ttlAt))).toBe(true);
    for (const [i, body] of asks.entries()) {
      const r = await ask(body);
      expect(r.status, JSON.stringify(body)).toBe(200);
      expect(r).toEqual(plain[i]);
      expect(JSON.stringify(r.body)).not.toContain("_seconds");
    }
  });
});
