import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { allConnectors } from "@/lib/connectors/catalog";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { brandStrategyDocId } from "@/lib/types/brandStrategy";
import { forTenant } from "@/lib/tenant";
import { HOW_IT_WENT_WORDS } from "@/components/admin/brand-kit/strategyMessages";
import { GONE_TEXT, PREVIEW_NOTE, REST_TEXT, runMonthFromRequest, strategyMonthsView } from "./monthView";

// What the Strategy tab reads of How it went. Made-up brands and situations.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "member" };
const B: TenantContext = { ...A, tenantId: "ten_B" };
const NOW = new Date("2026-12-20T10:00:00.000Z");
const month = (m: string, rows: Array<{ id: string }>) => ({ month: m, at: `${m}-28T00:00:00.000Z`, strategyAt: "2026-10-20T09:00:00.000Z", rows: rows.map((r) => ({ ...r, live: 1 })) });

async function seed(db: FakeFirestore, ctx: TenantContext, approvedAt: string | null, months: unknown[] = []) {
  const text = "Back pain after desk work";
  await brandMapRecords(ctx, db).create("sit", "sit_aaaaaa01", { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: 0, createdAt: "", updatedAt: "" });
  db.seed("brand_strategy", brandStrategyDocId(ctx.tenantId), { tenantId: ctx.tenantId, rev: 3, approved: approvedAt ? { focusSituationIds: ["sit_aaaaaa01"], at: approvedAt } : null, months } as never);
}

beforeEach(() => {
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "STRATEGY_RESULTS_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("How it went as the tab reads it", () => {
  it("shows each kept month with its rows' words read from the map now", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-10-20T09:00:00.000Z", [month("2026-11", [{ id: "sit_aaaaaa01" }, { id: "sit_gone0001" }, { id: "rest" }])]);
    const v = await strategyMonthsView(A, { db, now: () => NOW, catalog: allConnectors });
    expect(v).toMatchObject({ approvedAt: "2026-10-20T09:00:00.000Z", tooEarly: false, nextLookOn: "2027-01-02" });
    expect(v.months[0]!.rows.map((r) => r.text)).toEqual(["Back pain after desk work", GONE_TEXT, REST_TEXT]);
    // Nothing connected: every kind says what could measure it.
    expect(v.measuring.map((c) => c.state)).toEqual(["not_connected", "not_connected", "not_connected", "not_connected"]);
  });

  it("is too early to tell until the first full month is added up, and reads another brand's record never", async () => {
    const db = new FakeFirestore();
    // Approved on 1 Dec after midnight: January is the first full month, added up on 2 Feb.
    await seed(db, A, "2026-12-01T09:00:00.000Z");
    await seed(db, B, "2026-10-20T09:00:00.000Z", [month("2026-11", [{ id: "rest" }])]);
    const v = await strategyMonthsView(A, { db, now: () => NOW, catalog: allConnectors });
    expect(v).toMatchObject({ tooEarly: true, months: [], firstApprovedAt: "2026-12-01T09:00:00.000Z", nextLookOn: "2027-02-02" });
    const none = await strategyMonthsView({ ...A, tenantId: "ten_C" }, { db, now: () => NOW, catalog: allConnectors });
    expect(none).toMatchObject({ approvedAt: null, tooEarly: true, months: [] });
  });

  it("counts too early from the first approval, so approving a change later never hides the months, and says when the next look is", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-12-10T09:00:00.000Z", [month("2026-11", [{ id: "rest" }])]);
    await forTenant(A, db).brandStrategy.claim(brandStrategyDocId("ten_A"), () => ({ history: [{ focusSituationIds: ["sit_aaaaaa01"], at: "2026-10-20T09:00:00.000Z" }] }));
    const v = await strategyMonthsView(A, { db, now: () => NOW, catalog: allConnectors });
    expect(v).toMatchObject({ approvedAt: "2026-12-10T09:00:00.000Z", tooEarly: false });
    expect(v.months).toHaveLength(1);
    // On the 2nd, with last month not added up yet, the look is today.
    const db2 = new FakeFirestore();
    await seed(db2, A, "2026-10-20T09:00:00.000Z");
    expect((await strategyMonthsView(A, { db: db2, now: () => new Date("2026-12-02T08:00:00.000Z"), catalog: allConnectors })).nextLookOn).toBe("2026-12-02");
  });

  it("never shows a partial first month, even one stored by an older build", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-10-20T09:00:00.000Z", [month("2026-11", [{ id: "rest" }]), month("2026-10", [{ id: "rest" }])]);
    const v = await strategyMonthsView(A, { db, now: () => NOW, catalog: allConnectors });
    expect(v.months.map((m) => m.month)).toEqual(["2026-11"]);
  });

  it("by hand, adds up last month only when it is due and not kept, never again after", async () => {
    const db = new FakeFirestore();
    await seed(db, A, null);
    const outcomes = vi.fn(async () => ({ coverage: [], byPage: {}, site: {}, more: [], periods: {}, failed: [] }));
    const deps = { db, now: () => new Date("2026-12-02T10:00:00.000Z"), loadTenant: async () => null, outcomes, catalog: () => [] };
    expect(await (await runMonthFromRequest(A, {}, deps)).json()).toEqual({ error: "no_month" });
    await forTenant(A, db).brandStrategy.claim(brandStrategyDocId("ten_A"), () => ({ approved: { focusSituationIds: ["sit_aaaaaa01"], at: "2026-10-20T09:00:00.000Z" } }));
    const first = await runMonthFromRequest(A, {}, deps);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { howItWent: { months: Array<{ month: string }> } }).howItWent.months.map((m) => m.month)).toEqual(["2026-11"]);
    const again = await runMonthFromRequest(A, {}, { ...deps, now: () => new Date("2026-12-09T10:00:00.000Z") });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "no_month_due", nextLookOn: "2027-01-02" });
    expect(outcomes).toHaveBeenCalledTimes(1);
    expect((await runMonthFromRequest(A, { tenantId: "ten_B" }, deps)).status).toBe(400);
  });

  it("by hand with preview, answers this month so far and writes nothing", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-11-20T09:00:00.000Z");
    const before = await forTenant(A, db).brandStrategy.getById(brandStrategyDocId("ten_A"));
    const outcomes = vi.fn(async () => ({ coverage: [], byPage: {}, site: {}, more: [], periods: {}, failed: [] }));
    const r = await runMonthFromRequest(A, { preview: true }, { db, now: () => NOW, loadTenant: async () => null, outcomes, catalog: () => [] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { preview: { kept: boolean; note: string; month: { month: string; rows: Array<{ id: string; text: string }> } } };
    expect(body.preview).toMatchObject({ kept: false, note: PREVIEW_NOTE("2027-01-02"), month: { month: "2026-12" } });
    expect(body.preview.month.rows.map((x) => x.text)).toEqual(["Back pain after desk work", REST_TEXT]);
    expect(await forTenant(A, db).brandStrategy.getById(brandStrategyDocId("ten_A"))).toEqual(before);
    // November, the month it was approved in, never counts: the preview says so.
    const nov = await runMonthFromRequest(A, { preview: true }, { db, now: () => new Date("2026-11-25T10:00:00.000Z"), loadTenant: async () => null, outcomes, catalog: () => [] });
    expect(((await nov.json()) as { preview: { note: string } }).preview.note).toBe(PREVIEW_NOTE("2027-01-02", false));
  });

  it("keeps its words to house style", () => {
    const d = { starsKept: 3, starsRemoved: 1, claimsEdited: 2, picksSkipped: 2, checksActed: 1, checksDismissed: 1, capped: true };
    const lines = [
      HOW_IT_WENT_WORDS.tooEarly,
      HOW_IT_WENT_WORDS.tooEarlyWhen("14 Nov", "2 Dec"),
      HOW_IT_WENT_WORDS.noStrategy,
      HOW_IT_WENT_WORDS.noMonthYet("2 Dec"),
      HOW_IT_WENT_WORDS.partway("14 Nov"),
      HOW_IT_WENT_WORDS.roadmap(6, 8),
      HOW_IT_WENT_WORDS.restQuestions,
      PREVIEW_NOTE("2 Jan"),
      PREVIEW_NOTE("2 Jan", false),
      HOW_IT_WENT_WORDS.resultsFor("4 Nov", "1 Dec"),
      HOW_IT_WENT_WORDS.site(900, "Cloudflare"),
      HOW_IT_WENT_WORDS.more(["Found in search"]),
      HOW_IT_WENT_WORDS.did(d),
      HOW_IT_WENT_WORDS.did({ ...d, starsKept: 0, starsRemoved: 0, claimsEdited: 0, picksSkipped: 0, checksActed: 0, checksDismissed: 0, capped: false }),
      REST_TEXT,
      GONE_TEXT,
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(HOW_IT_WENT_WORDS.did(d)).toBe("You, at least: kept 3 stars, removed 1 star, edited 2 claims, skipped 2 roadmap picks, acted on 1 weekly check and dismissed 1 weekly check.");
    expect(HOW_IT_WENT_WORDS.did({ ...d, starsKept: 0, starsRemoved: 0, claimsEdited: 0, picksSkipped: 0, checksActed: 0, checksDismissed: 0, capped: false })).toBe("You: no changes to the strategy this month.");
  });
});
