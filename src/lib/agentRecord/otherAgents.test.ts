import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(async () => ({ id: "ten_acme", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [] })),
}));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantById: tenant.getTenantById }));

import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import type { AgentAction } from "@/lib/types/agentAction";
import { agentSuggestNotes } from "@/lib/brandNotes/agentApi";
import { removeFromRequest, updateFromRequest } from "@/lib/brandNotes/api";
import { createConnection } from "@/lib/connect/keys";
import { SANDBOX_CATALOG } from "@/lib/connect/sandbox";
import { acceptProductMap, startRepoAnalysis } from "@/lib/connect/repoAnalysis";
import { runBrandMapResearch } from "@/lib/brandMap/adminApi";
import { dismissBrandMapSuggestions, readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { runVerdict } from "./mapRuns";

async function records(db: FakeFirestore, ctx: TenantContext): Promise<AgentAction[]> {
  return (await forTenant(ctx, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

// The first notes test loads brand search's writers lazily, which takes a few seconds on a busy machine.
describe("notes Vizzy suggests", { timeout: 30_000 }, () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
  const deps = (db: FakeFirestore) => ({ db, embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])), limited: async () => false });
  beforeEach(() => {
    vi.stubEnv("BRAND_NOTES_ENABLED", "true");
    vi.stubEnv("BRAND_NOTES_CHAT_ENABLED", "true");
  });

  it("are one record each, by id and a fingerprint, never the text; kept and removed close them", async () => {
    const db = new FakeFirestore();
    const d = deps(db);
    const r = await agentSuggestNotes(admin, { notes: [{ text: "Buyers repot in spring, before the growing season." }, { text: "Most orders come in after a heatwave." }] }, d);
    expect(r.status).toBe(200);
    const open = await records(db, admin);
    expect(open).toHaveLength(2);
    expect(open.every((a) => a.action === "brand_note.suggest" && a.state === "proposed" && a.draft?.kind === "brand_note")).toBe(true);
    expect(JSON.stringify(open)).not.toMatch(/repot|heatwave/i);

    const [first, second] = open;
    const kept = await updateFromRequest(admin, first!.draft!.ref, { status: "kept", text: "Buyers repot in spring, before the season starts." }, d);
    expect(kept.status).toBe(200);
    const removed = await removeFromRequest(admin, second!.draft!.ref, d);
    expect(removed.status).toBe(200);
    const after = new Map((await records(db, admin)).map((a) => [a.id, a]));
    expect(after.get(first!.id)).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_admin" }, result: { edited: true } });
    expect(after.get(second!.id)).toMatchObject({ state: "declined", declined: { reason: "dismissed" } });
  });

  it("kept as they were are not edited", async () => {
    const db = new FakeFirestore();
    const d = deps(db);
    await agentSuggestNotes(admin, { notes: [{ text: "Buyers repot in spring, before the growing season." }] }, d);
    const [a] = await records(db, admin);
    await updateFromRequest(admin, a!.draft!.ref, { status: "kept" }, d);
    expect((await records(db, admin))[0]).toMatchObject({ state: "acted", result: { edited: false } });
  });
});

describe("learning a product's map from its repo", () => {
  const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", email: "admin@example.com", role: "admin", userId: "usr_admin" };
  const MAP = {
    version: 1,
    summary: "Tracks plant care.",
    onboardingSteps: [{ id: "add_plant", label: "Add a plant", completion: "A plant exists", path: "/plants", detection: "server_event", confidence: "high", evidence: [] }],
    events: [],
    traits: [],
    facts: [],
    glossary: [],
    hooks: [],
    warnings: [],
    entityKinds: [],
  } as const;

  it("is research's, asked for by the member; a newer run supersedes it, and accepting keeps it", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Plant app", kind: "custom", catalog: SANDBOX_CATALOG }, db);
    const trigger = async () => undefined;
    const first = await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/example/plants" }] }, { db, nowMs: Date.parse("2026-12-01T10:00:00Z"), trigger });
    if (!first.ok) throw new Error(first.error);
    await forTenant(ctx, db).repoAnalyses.update(first.value.analysis.id, { status: "failed", error: "job_failed" });
    __resetRateLimitState();
    const second = await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/example/plants" }] }, { db, nowMs: Date.parse("2026-12-01T11:00:00Z"), trigger });
    if (!second.ok) throw new Error(second.error);
    const rows = await records(db, ctx);
    expect(rows.map((a) => [a.agent, a.action, a.state, a.declined?.reason ?? null])).toEqual([
      ["research", "product_map.learn", "declined", "superseded"],
      ["research", "product_map.learn", "proposed", null],
    ]);
    expect(rows[1]).toMatchObject({ draft: { kind: "repo_map", ref: connection.id }, requestedBy: { type: "member", id: "usr_admin" }, proposal: { label: "Plant app", run: second.value.analysis.id } });

    await forTenant(ctx, db).repoAnalyses.update(second.value.analysis.id, { status: "done", map: MAP as never });
    const accepted = await acceptProductMap(ctx, connection.id, second.value.analysis.id, { steps: ["add_plant"] }, { db });
    expect(accepted.ok).toBe(true);
    expect((await records(db, ctx))[1]).toMatchObject({ state: "acted", result: { kept: 1 } });
  });
});

describe("brand map research", () => {
  const ctx: TenantContext = { tenantId: "ten_acme", region: "us", userId: "u1", role: "admin", source: "idtoken" };
  const ANSWER = ["CATEGORY: AI visibility tracking", "NAME: Rivalco | alternative", "NAME: Otherco | alternative"].join("\n");
  const propose = {
    workspaces: async () => [{ id: "ws1", updatedAt: "2026-10-01" }],
    grounded: (async () => ({ text: ANSWER, model: "m", sources: [], supports: [] })) as never,
    modelReady: () => true,
    retrieve: (async () => ({ formatted: "Acme tracks AI answers.", chunks: [] })) as never,
    sitePages: async () => ({ pages: [], repoPaths: [] }),
    fetchHome: async () => null,
    plans: (async () => []) as never,
  };
  beforeEach(() => vi.stubEnv("BRAND_MAP_ENABLED", "true"));
  const T1 = Date.parse("2026-12-01T10:00:00Z");
  const T2 = T1 + 60_000;

  it("is one record per run; the next run closes it, superseded when nobody decided any", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme Inc" } }) }, { db });
    expect((await runBrandMapResearch(ctx, { db, propose, nowMs: T1 })).ok).toBe(true);
    const [run] = await records(db, ctx);
    expect(run).toMatchObject({ agent: "research", action: "brand_map.research", state: "proposed", requestedBy: { type: "member", id: "u1" } });
    expect((run!.proposal!.keys as string[]).length).toBeGreaterThan(1);
    expect(JSON.stringify(run!.proposal)).not.toMatch(/Rivalco|Otherco/);
    expect((await runBrandMapResearch(ctx, { db, propose, nowMs: T2 })).ok).toBe(true);
    const rows = await records(db, ctx);
    expect(rows.map((a) => [a.state, a.declined?.reason ?? null])).toEqual([
      ["declined", "superseded"],
      ["proposed", null],
    ]);
  });

  it("the next run closes it as acted when some were accepted, counting the dismissed", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme Inc" } }) }, { db });
    await runBrandMapResearch(ctx, { db, propose, nowMs: T1 });
    const read = await readBrandMap(ctx, db);
    if (read.state !== "ok") throw new Error("no map");
    const [one, ...rest] = read.map.suggestions;
    // One accepted (it leaves the suggestions without being dismissed), the rest dismissed.
    await dismissBrandMapSuggestions(ctx, rest.map((s) => s.key), { db });
    const raw = db.raw("brand_maps", `bm_${ctx.tenantId}`) as { suggestions: Array<{ key: string }> };
    db.seed("brand_maps", `bm_${ctx.tenantId}`, { ...raw, suggestions: raw.suggestions.filter((s) => s.key !== one!.key) });
    await runBrandMapResearch(ctx, { db, propose, nowMs: T2 });
    expect((await records(db, ctx))[0]).toMatchObject({ state: "acted", actedBy: { type: "system", id: "agent_record" }, result: { kept: 1, dismissed: rest.length } });
  });

  it("closes by the map's own lists", () => {
    const s = { waitingKeys: 0, waitingRefs: 0, kept: 0, dismissed: 0, gone: 0 };
    expect(runVerdict({ ...s, waitingKeys: 2 })).toBeNull();
    expect(runVerdict({ ...s, waitingRefs: 1 }, true)).toBeNull();
    expect(runVerdict({ ...s, kept: 4, dismissed: 8 })).toEqual({ to: "acted", result: { kept: 4, dismissed: 8 } });
    expect(runVerdict({ ...s, dismissed: 3 })).toEqual({ to: "declined", reason: "dismissed" });
    expect(runVerdict({ ...s, waitingKeys: 2, dismissed: 1 }, true)).toEqual({ to: "declined", reason: "superseded" });
    expect(runVerdict({ ...s, gone: 2 })).toEqual({ to: "declined", reason: "stale" });
  });
});
