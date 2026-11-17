import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { isScanTick, runCompetitorChecks } from "./tick";
import { monitorCompetitor } from "./store";
import type { StepDeps } from "./steps";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const tenant = (id: string, grantedFeatures: string[] = []) => ({ id, region: "us", grantedFeatures }) as unknown as Tenant;

// 2026-11-16 00:00 UTC is a scan tick (a multiple of 30 minutes); two minutes later isn't.
const SCAN = Date.parse("2026-11-16T00:00:00Z");
const QUIET = SCAN + 120_000;

let db: FakeFirestore;
let fetched: string[];
const fetch = (async (url: string) => {
  fetched.push(url);
  return new Response("", { status: 404 });
}) as unknown as StepDeps["fetch"];

beforeEach(() => {
  db = new FakeFirestore();
  fetched = [];
  vi.stubEnv("COMPETITORS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function watching(ctx: TenantContext, website: string, due: boolean) {
  const r = await monitorCompetitor(ctx, { website, name: website }, { db });
  if (!r.ok) throw new Error(r.error);
  await forTenant(ctx, db).competitors.update(r.value.competitor.id, {
    status: "watching",
    stage: null,
    news: { url: `https://${website}/news`, feedUrl: null, chosenBy: "manual", baselineAt: "2026-11-01T00:00:00Z", checkedAt: null },
    nextPostsCheckAt: due ? "2026-11-01T00:00:00Z" : "2026-12-01T00:00:00Z",
  });
  return r.value.competitor.id;
}

describe("the scheduled checks", () => {
  it("do nothing with the switch off", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "");
    const listTenants = vi.fn(async () => [tenant("ten_A")]);
    expect(await runCompetitorChecks({ deadlineMs: SCAN + 25_000 }, { db, listTenants, clock: () => SCAN })).toMatchObject({ tenants: 0, advanced: 0 });
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("run due checks on a scan tick, across brands, and skip a brand without the feature", async () => {
    expect(isScanTick(SCAN)).toBe(true);
    await watching(A, "acme-dental.example", true);
    await watching(A, "brightsmile.example", false);
    await watching(B, "rival.example", true);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    const r = await runCompetitorChecks(
      { deadlineMs: SCAN + 60_000 },
      { db, fetch, listTenants: async () => [tenant("ten_A", ["competitors"]), tenant("ten_B")], clock: () => SCAN },
    );
    expect(r).toMatchObject({ scanned: true, tenants: 1, advanced: 1, failed: 0 });
    expect(fetched.some((u) => u.includes("acme-dental.example"))).toBe(true);
    expect(fetched.some((u) => u.includes("brightsmile.example") || u.includes("rival.example"))).toBe(false);
  });

  it("between scans, only carry on setups", async () => {
    expect(isScanTick(QUIET)).toBe(false);
    await watching(A, "acme-dental.example", true);
    const setup = await monitorCompetitor(A, { website: "newcomer.example", name: "Newcomer" }, { db });
    if (!setup.ok) throw new Error(setup.error);
    const r = await runCompetitorChecks({ deadlineMs: QUIET + 60_000 }, { db, fetch, listTenants: async () => [tenant("ten_A")], clock: () => QUIET });
    expect(r).toMatchObject({ scanned: false, advanced: 1 });
    expect(fetched.every((u) => u.includes("newcomer.example"))).toBe(true);
  });

  it("start nothing with too little time left, and carry on past a brand that fails", async () => {
    await watching(A, "acme-dental.example", true);
    expect(await runCompetitorChecks({ deadlineMs: SCAN + 5_000 }, { db, fetch, listTenants: async () => [tenant("ten_A")], clock: () => SCAN })).toMatchObject({ advanced: 0 });
    const broken = { ...tenant("ten_X"), region: undefined } as unknown as Tenant;
    const r = await runCompetitorChecks({ deadlineMs: SCAN + 60_000 }, { db, fetch, listTenants: async () => [broken, tenant("ten_A")], clock: () => SCAN });
    expect(r).toMatchObject({ tenants: 1, advanced: 1 });
  });
});
