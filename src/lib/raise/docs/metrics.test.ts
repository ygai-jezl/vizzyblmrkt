import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { TenantCollection } from "@/lib/tenant";
import { agentInsightsSummary } from "@/lib/insights/agentApi";
import { fillBlock, metricReader, numberOptions, refreshBlocks, sameRequest, sameTyped, typedBlock } from "./metrics";
import { ACME, NOW, block, slide, weeksOf } from "./testing/fixtures";

const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sign-up blocks", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
    // 9 sign-ups over the last 12 weeks, 1 outside them, and another brand's.
    for (const [i, d] of [1, 2, 3, 10, 11, 20, 40, 60, 80, 100].entries()) db.seed("signups", `s${i}`, { tenantId: "ten_acme", campaignId: "camp_spring", status: "verified_active", createdAt: ago(d) });
    db.seed("signups", "other", { tenantId: "ten_other", campaignId: "x", status: "verified_active", createdAt: ago(1) });
  });

  it("match Insights and get_insights_summary on the same data and clock", async () => {
    const reader = metricReader(ACME, { db, now: () => NOW });
    const total = await fillBlock(reader, { meaning: "waitlistSignups", grain: "total", weeks: 12 });
    const weekly = await fillBlock(reader, { meaning: "waitlistSignups", grain: "week", weeks: 12 });
    const summary = (await agentInsightsSummary(ACME, { lifecycle: false, invites: false, now: NOW }, db)).body as { signups: { weekly: Array<{ weekStart: string; signups: number }> } };
    const sum = summary.signups.weekly.reduce((n, w) => n + w.signups, 0);
    expect(sum).toBe(9);
    expect(total.block).toMatchObject({ meaning: "waitlistSignups", value: 9, display: "9", periodWords: "12 weeks to 26 Nov", source: { kind: "insights" }, asOf: NOW.toISOString() });
    expect(weekly.block.series!.map((p) => ({ weekStart: p.start, signups: p.value }))).toEqual(summary.signups.weekly);
    expect(weekly.block.name).toBe("Sign-ups a week");
    expect(total.need).toBeNull();
  });

  it("work growth out from the two halves of the weeks", async () => {
    const reader = metricReader(ACME, { now: () => NOW, weekly: async () => weeksOf([1, 1, 1, 1, 1, 5, 2, 2, 2, 2, 2, 2]) });
    const g = await fillBlock(reader, { meaning: "signupGrowth", grain: "total" });
    expect(g.block).toMatchObject({ value: 20, unit: "percent", display: "+20%", name: "Sign-up growth" });
    const four = await fillBlock(reader, { meaning: "waitlistSignups", grain: "total", weeks: 4 });
    expect(four.block).toMatchObject({ value: 8, weeks: 4, periodWords: "4 weeks to 26 Nov" });
  });

  it("give null and a need with no sign-ups or a failed read, never 0", async () => {
    for (const weeks of [weeksOf(Array(12).fill(0)), weeksOf([...Array(11).fill(3), null]), []]) {
      const reader = metricReader(ACME, { now: () => NOW, weekly: async () => weeks });
      const f = await fillBlock(reader, { meaning: "waitlistSignups", grain: "week" });
      expect(f.block.value).toBeNull();
      expect(f.block.display).toBe("");
      expect(f.block.series).toBeUndefined();
      expect(f.need).toBe("a number that shows demand");
      expect((await fillBlock(reader, { meaning: "signupGrowth", grain: "total" })).block.value).toBeNull();
    }
    const zeroFirst = metricReader(ACME, { now: () => NOW, weekly: async () => weeksOf([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]) });
    expect((await fillBlock(zeroFirst, { meaning: "signupGrowth", grain: "total" })).block.value).toBeNull();
    expect(await numberOptions(zeroFirst)).toEqual({ waitlist: { weeks: 12, hasData: true }, growth: { hasData: false }, launches: null });
  });
});

describe("people on a launch", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
    db.seed("campaigns", "camp_spring", { tenantId: "ten_acme", waitlistName: "Spring launch" });
    db.seed("contacts", "c1", { tenantId: "ten_acme", memberOf: ["all", "launch:camp_spring"] });
    db.seed("contacts", "c2", { tenantId: "ten_acme", memberOf: ["all", "launch:camp_spring"] });
    // An investor in People, on no launch: never counted.
    db.seed("contacts", "c3", { tenantId: "ten_acme", memberOf: ["all"] });
  });

  it("are off without the one People list", async () => {
    const reader = metricReader(ACME, { db, now: () => NOW });
    const f = await fillBlock(reader, { meaning: "launchSignups", grain: "total", launchId: "camp_spring" });
    expect(f.block.value).toBeNull();
    expect(f.warning).toMatch(/one People list/);
    expect((await numberOptions(reader)).launches).toBeNull();
  });

  it("count one launch's people, and nothing reads the People total", async () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
    const counted = vi.spyOn(TenantCollection.prototype, "count");
    const reader = metricReader(ACME, { db, now: () => NOW });
    const f = await fillBlock(reader, { meaning: "launchSignups", grain: "total", launchId: "camp_spring" });
    expect(f.block).toMatchObject({ value: 2, name: "People on Spring launch", source: { kind: "audience" }, launchId: "camp_spring" });
    expect((await numberOptions(reader)).launches).toEqual([{ id: "camp_spring", name: "Spring launch" }]);
    for (const [where] of counted.mock.calls) expect(JSON.stringify(where)).not.toContain('"all"');
    expect((await fillBlock(reader, { meaning: "launchSignups", grain: "total", launchId: "camp_none" })).block.value).toBeNull();
  });
});

describe("typed blocks", () => {
  it("stamp who typed them and when, and say the same thing back", () => {
    const b = typedBlock({ name: "Monthly sales", value: 14200, unit: "money", per: "month", from: "your till" }, { typedBy: "usr_fern" }, NOW);
    expect(b).toMatchObject({ meaning: "typed", grain: "total", value: 14200, currency: "GBP", display: "£14,200 a month", source: { kind: "typed", from: "your till", typedBy: "usr_fern" }, asOf: NOW.toISOString() });
    expect(sameTyped(b, { name: "Monthly sales", value: 14200, unit: "money", per: "month", from: "your till" })).toBe(true);
    expect(sameTyped(b, { name: "Monthly sales", value: 14300, unit: "money", per: "month", from: "your till" })).toBe(false);
    const said = typedBlock({ name: "MRR", value: 6200, unit: "money", currency: "USD" }, { typedBy: "vizzy", saidInChat: true, quote: "our MRR is $6,200" }, NOW);
    expect(said.source).toEqual({ kind: "typed", typedBy: "vizzy", saidInChat: true, quote: "our MRR is $6,200" });
    const series = typedBlock({ name: "Sales", value: 3, unit: "count", series: [{ label: "Jan", value: 1 }, { label: "Feb", value: 2 }] }, { typedBy: "usr_fern" }, NOW);
    expect(series.grain).toBe("month");
  });
});

describe("refreshing numbers", () => {
  it("fills server blocks again, leaves typed ones, and lists only what moved", async () => {
    const old = block({ id: "mb_aaaaaaaa", value: 8, display: "8", asOf: "2026-11-01T00:00:00.000Z" });
    const typed = block({ id: "mb_tttttttt", meaning: "typed", value: 5, display: "5", source: { kind: "typed", typedBy: "usr_admin" } });
    const reader = metricReader(ACME, { now: () => NOW, weekly: async () => weeksOf(Array(12).fill(1)) });
    const { slides, changed } = await refreshBlocks(reader, [slide({ blocks: [old, typed] })]);
    expect(changed).toEqual([{ slideN: 1, name: "sign-ups", from: "8", to: "12" }]);
    expect(slides[0]!.blocks[0]).toMatchObject({ id: "mb_aaaaaaaa", value: 12, asOf: NOW.toISOString() });
    expect(slides[0]!.blocks[1]).toBe(typed);
    const again = await refreshBlocks(reader, slides);
    expect(again.changed).toEqual([]);
    expect(sameRequest(old, { meaning: "waitlistSignups", grain: "total" })).toBe(true);
    expect(sameRequest(old, { meaning: "waitlistSignups", grain: "total", weeks: 4 })).toBe(false);
  });
});
