import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The map's records (subjects, questions, situations) by status, as runState reads them.
const recs = vi.hoisted(() => ({ status: new Map<string, string>() }));
vi.mock("@/lib/tenant/brandMapRecords", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brandMapRecords: () => ({
    get: async (kind: string, id: string) => (recs.status.has(`${kind}:${id}`) ? { id, status: recs.status.get(`${kind}:${id}`) } : null),
  }),
}));

import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapChangeSchema, BrandMapDecidedSchema, type BrandMapChange } from "@/lib/types/brandMap";
import type { AgentAction } from "@/lib/types/agentAction";
import { applyChange } from "@/lib/brandMap/changes";
import { dismissBrandMapSuggestions, fileBrandMapSuggestions, readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { catchUpBrand } from "./catchUp";
import { closeResearchBefore, recordMapRun } from "./mapRuns";

// A made-up brand.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a1", role: "admin" };
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
const DAY = 86_400_000;

const subject = (name: string): BrandMapChange => BrandMapChangeSchema.parse({ type: "add_subject", name });
const subjects = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ change: subject(`${prefix} ${i + 1}`) }));

async function records(db: FakeFirestore): Promise<AgentAction[]> {
  return (await forTenant(A, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

async function file(db: FakeFirestore, from: "vizzy" | "research", items: Array<{ change: BrandMapChange }>, nowMs: number) {
  const r = await fileBrandMapSuggestions(A, { from, items, ...(from === "research" ? { replaceOwn: true } : {}) }, { db, nowMs });
  if (!r.ok) throw new Error(r.error);
  return r.value.filed.map((s) => s.key);
}

async function accept(db: FakeFirestore, key: string) {
  const read = await readBrandMap(A, db);
  if (read.state !== "ok") throw new Error("no map");
  const s = read.map.suggestions.find((x) => x.key === key)!;
  const decided = applyChange(BrandMapDecidedSchema.parse(read.map), s.change).decided;
  const saved = await saveBrandMap(A, { baseRev: read.map.rev, decided, accepted: [key] }, { db });
  if (!saved.ok) throw new Error(saved.error);
}

const catchUp = (db: FakeFirestore, at = T0 + DAY) => catchUpBrand(A, { deadlineMs: at + 60_000, db, now: () => at });

beforeEach(() => {
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  recs.status.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("a map run's suggestions the map drops on its own", () => {
  it("are not counted as accepted: only a change the map now holds is", async () => {
    const db = new FakeFirestore();
    const keys = await file(db, "vizzy", subjects("Topic", 5), T0);
    await recordMapRun(A, { action: "brand_map.suggest", keys, refs: [] }, { db, nowMs: T0 });
    await accept(db, keys[0]!);
    expect((await dismissBrandMapSuggestions(A, [keys[1]!], { db })).ok).toBe(true);
    // Later chat calls fill Vizzy's 30 suggestions: the map drops this run's other 3, oldest first.
    await file(db, "vizzy", subjects("Later", 30), T0 + 1000);
    const read = await readBrandMap(A, db);
    if (read.state !== "ok") throw new Error("no map");
    expect(read.map.suggestions.some((s) => keys.includes(s.key))).toBe(false);
    await catchUp(db);
    const run = (await records(db)).find((a) => a.action === "brand_map.suggest");
    expect(run).toMatchObject({ state: "acted", result: { kept: 1, dismissed: 1 } });
  });

  it("close a run whose suggestions were all dropped as nobody's decision", async () => {
    const db = new FakeFirestore();
    const keys = await file(db, "vizzy", subjects("Topic", 5), T0);
    await recordMapRun(A, { action: "brand_map.suggest", keys, refs: [] }, { db, nowMs: T0 });
    await file(db, "vizzy", subjects("Later", 30), T0 + 1000);
    await catchUp(db);
    const run = (await records(db)).find((a) => a.action === "brand_map.suggest");
    expect(run).toMatchObject({ state: "declined", declined: { reason: "stale" }, decidedBy: { type: "system", id: "agent_record" }, proposal: null });
  });
});

describe("a research run replaced while its proposals still wait", () => {
  it("keeps how many were replaced, so they are never counted as accepted later", async () => {
    const db = new FakeFirestore();
    const keys = await file(db, "research", subjects("Topic", 5), T0);
    recs.status.set("sub:sub_waiting1", "proposed");
    await recordMapRun(A, { action: "brand_map.research", keys, refs: ["sub:sub_waiting1"] }, { db, nowMs: T0 });
    // The next research run: the run before stays open for its proposal, without the replaced keys.
    await closeResearchBefore(A, { db, nowMs: T0 + 1000 });
    await file(db, "research", subjects("Fresh", 3), T0 + 1000);
    const rows = await records(db);
    expect(rows.map((a) => [a.state, a.declined?.reason ?? null])).toEqual([
      ["declined", "superseded"],
      ["proposed", null],
    ]);
    expect(rows[1]).toMatchObject({ action: "brand_map.research", draft: rows[0]!.draft, requestedBy: { type: "member", id: "usr_a1" }, proposal: { refs: ["sub:sub_waiting1"], replaced: 5 } });
    expect(rows[1]!.proposal!.keys).toBeUndefined();
    // Later the admin dismisses the proposal: research replaced the rest, nothing was accepted.
    recs.status.set("sub:sub_waiting1", "dismissed");
    await catchUp(db);
    expect((await records(db))[1]).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
  });

  it("still counts what was accepted before the next run", async () => {
    const db = new FakeFirestore();
    const keys = await file(db, "research", subjects("Topic", 4), T0);
    recs.status.set("q:q_waiting1", "proposed");
    await recordMapRun(A, { action: "brand_map.research", keys, refs: ["q:q_waiting1"] }, { db, nowMs: T0 });
    await accept(db, keys[0]!);
    await closeResearchBefore(A, { db, nowMs: T0 + 1000 });
    await file(db, "research", subjects("Fresh", 2), T0 + 1000);
    recs.status.set("q:q_waiting1", "dismissed");
    await catchUp(db);
    const open = (await records(db)).filter((a) => a.state !== "declined" || a.declined?.reason !== "superseded");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: "acted", result: { kept: 1, dismissed: 1 } });
  });
});
