import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { allConnectors } from "@/lib/connectors/catalog";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { brandStrategyDocId } from "@/lib/types/brandStrategy";
import { HOW_IT_WENT_WORDS } from "@/components/admin/brand-kit/strategyMessages";
import { GONE_TEXT, REST_TEXT, runMonthFromRequest, strategyMonthsView } from "./monthView";

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

  it("is too early to tell until a full month after approval, and reads another brand's record never", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-12-01T09:00:00.000Z");
    await seed(db, B, "2026-10-20T09:00:00.000Z", [month("2026-11", [{ id: "rest" }])]);
    const v = await strategyMonthsView(A, { db, now: () => NOW, catalog: allConnectors });
    expect(v).toMatchObject({ tooEarly: true, months: [] });
    const none = await strategyMonthsView({ ...A, tenantId: "ten_C" }, { db, now: () => NOW, catalog: allConnectors });
    expect(none).toMatchObject({ approvedAt: null, tooEarly: true, months: [] });
  });

  it("by hand, says there's no month to add up without a strategy approved before this month", async () => {
    const db = new FakeFirestore();
    await seed(db, A, "2026-12-01T09:00:00.000Z");
    const r = await runMonthFromRequest(A, { db, now: () => NOW, loadTenant: async () => null });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "no_month", month: "2026-11", from: "2026-11-01" });
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
