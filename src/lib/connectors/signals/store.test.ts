import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import type { TenantContext } from "@/lib/tenant";
import { DATA_SIGNAL_ID } from "@/lib/types/dataSignal";
import { blankSignal, countSignals, eraseSignals, getSignal, isQuiet, linkAction, saveDetection, signalIdFor, signalsOfConnection, type Detection } from "./store";
import { proposalReason, signalLines, signalTitle } from "./words";

// The signals store: fixed ids, refresh, blanking and erase, one brand never touching another's.
// Every site, search and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const CONN = "dcn_aaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-11-23T10:00:00.000Z");
const DAY = 86_400_000;

const detection = (over: Partial<Detection> = {}): Detection => ({
  connectionId: CONN,
  gen: 0,
  account: "sc-domain:fernhill.example",
  connectorId: "search-console",
  rule: "losing_page",
  key: { page: "/care/fiddle-leaf-fig", host: "fernhill.example" },
  label: "/care/fiddle-leaf-fig",
  numbers: { searchClicks: 41 },
  before: { searchClicks: 96 },
  window: { from: "2026-10-24", to: "2026-11-20", beforeFrom: "2026-09-26", beforeTo: "2026-10-23" },
  shownIn: "review",
  ...over,
});

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("signal ids", () => {
  it("are dsg_ and 24 hex, from the brand, connection, generation, rule and key, never the words", () => {
    const id = signalIdFor("ten_a", CONN, 0, "rising_search", { topic: "pet safe hanging plants" });
    expect(id).toMatch(DATA_SIGNAL_ID);
    expect(id).not.toContain("pet");
    expect(signalIdFor("ten_a", CONN, 0, "rising_search", { topic: "pet safe hanging plants" })).toBe(id);
    expect(signalIdFor("ten_b", CONN, 0, "rising_search", { topic: "pet safe hanging plants" })).not.toBe(id);
    expect(signalIdFor("ten_a", CONN, 1, "rising_search", { topic: "pet safe hanging plants" })).not.toBe(id);
    expect(signalIdFor("ten_a", CONN, 0, "within_reach", { topic: "pet safe hanging plants" })).not.toBe(id);
    expect(signalIdFor("ten_a", CONN, 0, "losing_page", { page: "/a", host: "fernhill.example" })).not.toBe(signalIdFor("ten_a", CONN, 0, "losing_page", { page: "/a", host: "www.fernhill.example" }));
  });
});

describe("saving a detection", () => {
  it("writes a row with 30 days to live, then refreshes it in place, keeping its action and round", async () => {
    const first = await saveDetection(A, detection(), { db, now: NOW });
    expect(first.quiet).toBe(false);
    expect(first.row).toMatchObject({ tenantId: "ten_a", rule: "losing_page", label: "/care/fiddle-leaf-fig", agentActionId: null, round: 0, dismissedUntil: null });
    expect(first.row.ttlAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    await linkAction(A, first.row.id, "aa_" + "1".repeat(40), 1, { db });
    const later = new Date(NOW.getTime() + DAY);
    const again = await saveDetection(A, detection({ numbers: { searchClicks: 39 } }), { db, now: later });
    expect(again.row).toMatchObject({ id: first.row.id, numbers: { searchClicks: 39 }, agentActionId: "aa_" + "1".repeat(40), round: 1 });
    expect(again.row.ttlAt).toEqual(new Date(later.getTime() + 30 * DAY));
    expect(db.dump("data_signals")).toHaveLength(1);
  });

  it("leaves a dismissed row alone until dismissedUntil, blanked but for its id, rule and action", async () => {
    const { row } = await saveDetection(A, detection(), { db, now: NOW });
    await linkAction(A, row.id, "aa_" + "2".repeat(40), 1, { db });
    expect(await blankSignal(A, row.id, { db, now: NOW, quietDays: 30 })).toBe(true);
    const blank = (await getSignal(A, row.id, { db }))!;
    expect(blank).toMatchObject({ rule: "losing_page", key: null, label: null, question: null, numbers: null, before: null, window: null, agentActionId: "aa_" + "2".repeat(40) });
    expect(blank.dismissedUntil).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    expect(isQuiet(blank, NOW)).toBe(true);
    const soon = await saveDetection(A, detection(), { db, now: new Date(NOW.getTime() + 10 * DAY) });
    expect(soon.quiet).toBe(true);
    expect((await getSignal(A, row.id, { db }))!.label).toBeNull();
    const after = await saveDetection(A, detection(), { db, now: new Date(NOW.getTime() + 31 * DAY) });
    expect(after.quiet).toBe(false);
    expect(after.row.label).toBe("/care/fiddle-leaf-fig");
  });

  it("keeps a dismissed row at least until dismissedUntil, and a stale blank changes no time", async () => {
    const { row } = await saveDetection(A, detection(), { db, now: NOW });
    await blankSignal(A, row.id, { db, now: new Date(NOW.getTime() + 20 * DAY), quietDays: 30 });
    expect((await getSignal(A, row.id, { db }))!.ttlAt).toEqual(new Date(NOW.getTime() + 50 * DAY));
    const { row: other } = await saveDetection(A, detection({ rule: "within_reach", key: { topic: "water a monstera" }, label: "water a monstera" }), { db, now: NOW });
    await blankSignal(A, other.id, { db, now: NOW });
    expect((await getSignal(A, other.id, { db }))!).toMatchObject({ label: null, dismissedUntil: null });
  });
});

describe("one brand's rows", () => {
  it("are never read, refreshed, blanked or erased by another brand", async () => {
    const { row } = await saveDetection(A, detection(), { db, now: NOW });
    expect(await getSignal(B, row.id, { db })).toBeNull();
    expect(await blankSignal(B, row.id, { db, now: NOW, quietDays: 30 })).toBe(false);
    expect(await signalsOfConnection(B, CONN, { db })).toEqual([]);
    expect(await eraseSignals(B, CONN, "all", { db })).toBe(0);
    expect(await countSignals(B, CONN, { db })).toBe(0);
    expect((await getSignal(A, row.id, { db }))!.label).toBe("/care/fiddle-leaf-fig");
    // B's own detection of the same thing gets an id of its own.
    const theirs = await saveDetection(B, detection(), { db, now: NOW });
    expect(theirs.row.id).not.toBe(row.id);
    expect(db.raw("data_signals", row.id)?.tenantId).toBe("ten_a");
  });

  it("erase by connection, all of them or the old generations only, by equality alone", async () => {
    await saveDetection(A, detection(), { db, now: NOW });
    await saveDetection(A, detection({ gen: 1 }), { db, now: NOW });
    await saveDetection(A, detection({ connectionId: "dcn_bbbbbbbbbbbbbbbbbbbb" }), { db, now: NOW });
    expect(await countSignals(A, CONN, { db })).toBe(2);
    expect(await eraseSignals(A, CONN, [0], { db })).toBe(1);
    expect((await signalsOfConnection(A, CONN, { db })).map((r) => r.gen)).toEqual([1]);
    expect(await eraseSignals(A, CONN, "all", { db })).toBe(1);
    expect(db.dump("data_signals")).toHaveLength(1);
    const ops: string[] = [];
    const shaped = shapeRecordingFirestore(db, ops);
    await signalsOfConnection(A, CONN, { db: shaped });
    await countSignals(A, CONN, { db: shaped });
    await eraseSignals(A, CONN, [0], { db: shaped });
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op, op).toMatch(/^where \S+ ==$/);
  });
});

describe("what a suggestion says", () => {
  const base = { atMost: false, mayChange: false, question: null as string | null };
  it("words a page losing clicks, with Google Analytics as a second line", () => {
    const s = {
      ...base,
      rule: "losing_page" as const,
      label: "/care/fiddle-leaf-fig",
      numbers: { searchClicks: 41, ga4Sessions: 64 },
      before: { searchClicks: 96, ga4Sessions: 118 },
      mayChange: true,
      window: { from: "2026-10-24", to: "2026-11-20", beforeFrom: "2026-09-26", beforeTo: "2026-10-23" },
    };
    expect(signalTitle(s)).toBe("Fewer Google clicks to /care/fiddle-leaf-fig");
    expect(signalLines(s)).toEqual([
      "41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before.",
      "Google Analytics: 64 sessions started there, down from 118 (may still change a little).",
    ]);
    expect(signalLines({ ...s, atMost: true, numbers: { searchClicks: 41 }, before: { searchClicks: 96 } }, { site: "fernhill.example" })).toEqual([
      "On fernhill.example: At most 41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before.",
    ]);
  });

  it("words a question within reach and a rising search, and a proposal's reason", () => {
    const reach = { ...base, rule: "within_reach" as const, label: "how often to water monstera", question: "How often should I water a monstera?", numbers: { searchPosition: 8.6, searchImpressions: 1900 }, before: null, window: { from: "2026-10-24", to: "2026-11-20" } };
    expect(signalTitle(reach)).toBe("“How often should I water a monstera?” could rank higher on Google");
    expect(signalLines(reach)).toEqual(["Average position 8.6 and 1,900 impressions for the search “how often to water monstera” in the 28 days to 20 Nov."]);
    const rising = { ...base, rule: "rising_search" as const, label: "pet safe hanging plants", numbers: { searchImpressions: 260 }, before: { searchImpressions: 40 }, window: { from: "2026-11-07", to: "2026-11-20", beforeFrom: "2026-10-24", beforeTo: "2026-11-06" } };
    expect(signalTitle(rising)).toBe("More people search “pet safe hanging plants”");
    expect(signalLines(rising)).toEqual(["260 impressions in the 14 days to 20 Nov, up from 40. Nothing on your brand map answers it yet."]);
    expect(proposalReason(rising)).toBe("260 impressions in the 14 days to 20 Nov, up from 40");
    expect(proposalReason({ ...rising, before: { searchImpressions: 0 } })).toBe("260 impressions in the 14 days to 20 Nov, up from none");
    expect(proposalReason({ ...rising, atMost: true })).toBe("260 impressions in the 14 days to 20 Nov, up from at most 40");
  });

  it("says nothing for a blanked row", () => {
    expect(signalTitle({ rule: "losing_page", label: null, question: null })).toBeNull();
    expect(signalLines({ rule: "losing_page", label: null, numbers: null, before: null, window: null, atMost: false, mayChange: false })).toEqual([]);
  });
});
