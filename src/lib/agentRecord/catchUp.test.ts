import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { AgentAction } from "@/lib/types/agentAction";
import { samplePlan, sampleHub } from "@/lib/content/blog/testing/samplePlan";
import { CATCH_UP, catchUpBrand, inSlot, runAgentRecordCatchUp, slotOf } from "./catchUp";
import { recordDraft, styleKeyPart, type RecordDraftInput } from "./record";
import { recordMapRun } from "./mapRuns";
import { planRef } from "./drafts";

// Made-up brands.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_a1", role: "admin" };
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
const DAY = 86_400_000;

async function records(db: FakeFirestore): Promise<AgentAction[]> {
  return (await forTenant(A, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
const record = (db: FakeFirestore, input: RecordDraftInput, at = T0) => recordDraft(A, input, { db, nowMs: at });
const run = (db: FakeFirestore, at = T0 + DAY) => catchUpBrand(A, { deadlineMs: at + 60_000, db, now: () => at });
const stateOf = (a: AgentAction | undefined) => [a?.state, a?.declined?.reason ?? null, a?.decidedBy?.type ?? null];

beforeEach(() => vi.stubEnv("AGENT_RECORD_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("the slot", () => {
  it("gives each brand one 2 minute slot a day", () => {
    for (const id of ["ten_A", "ten_B", "ten_C"]) {
      expect(slotOf(id)).toBeGreaterThanOrEqual(0);
      expect(slotOf(id)).toBeLessThan(CATCH_UP.SLOTS);
      const day = Math.floor(T0 / DAY) * DAY;
      let hits = 0;
      for (let t = day; t < day + DAY; t += CATCH_UP.TICK_MS) if (inSlot(id, t)) hits += 1;
      expect(hits, id).toBe(1);
    }
  });

  it("runs only the brands whose slot it is, only while on, within its budget", async () => {
    const db = new FakeFirestore();
    const tenants = [
      { id: "ten_A", region: "us", status: "active" },
      { id: "ten_B", region: "us", status: "active" },
    ] as Tenant[];
    const listTenants = vi.fn(async () => tenants);
    const slotA = Math.floor(T0 / DAY) * DAY + slotOf("ten_A") * CATCH_UP.TICK_MS;
    vi.stubEnv("AGENT_RECORD_ENABLED", "false");
    expect(await runAgentRecordCatchUp({ deadlineMs: slotA + 60_000 }, { db, listTenants, now: () => slotA })).toEqual({ brands: 0, read: 0, closed: 0 });
    expect(listTenants).not.toHaveBeenCalled();
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    const brands = (await runAgentRecordCatchUp({ deadlineMs: slotA + 60_000 }, { db, listTenants, now: () => slotA })).brands;
    expect(brands).toBe(slotOf("ten_B") === slotOf("ten_A") ? 2 : 1);
    expect((await runAgentRecordCatchUp({ deadlineMs: slotA + 1_000 }, { db, listTenants, now: () => slotA })).brands).toBe(0);
  });
});

describe("closing what moved on another way", () => {
  it("expires a record past its 90 days, as nobody's decision, also where person links are off", async () => {
    const db = new FakeFirestore();
    db.seed("invite_waves", "wav_1", { tenantId: "ten_A", campaignId: "camp1", status: "draft", size: 5 });
    await record(db, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_1" }, launchId: "camp1", href: "/x" });
    expect(await run(db, T0 + 91 * DAY)).toEqual({ read: 1, closed: 1 });
    expect(stateOf((await records(db))[0])).toEqual(["declined", "expired", "system"]);
  });

  it("closes a journey published by the engine switch as acted by the system, and a deleted one as stale", async () => {
    const db = new FakeFirestore();
    db.seed("lifecycle_journeys", "lcj_1", { tenantId: "ten_A", status: "active", publishedVersion: 2 });
    db.seed("lifecycle_versions", "lcj_1_v2", { tenantId: "ten_A", journeyId: "lcj_1", version: 2, publishedAt: new Date(T0 + 1000).toISOString() });
    await record(db, { action: "lifecycle_journey.draft", draft: { kind: "lifecycle_journey", ref: "lcj_1" }, href: "/x" });
    await record(db, { action: "lifecycle_journey.draft", draft: { kind: "lifecycle_journey", ref: "lcj_gone" }, href: "/x" });
    await run(db);
    const rows = await records(db);
    const byRef = new Map(rows.map((a) => [a.draft!.ref, a]));
    expect(stateOf(byRef.get("lcj_1"))).toEqual(["acted", null, "system"]);
    expect(stateOf(byRef.get("lcj_gone"))).toEqual(["declined", "stale", "system"]);
  });

  it("leaves a journey published before Vizzy's draft waiting", async () => {
    const db = new FakeFirestore();
    db.seed("lifecycle_journeys", "lcj_1", { tenantId: "ten_A", status: "active", publishedVersion: 1 });
    db.seed("lifecycle_versions", "lcj_1_v1", { tenantId: "ten_A", journeyId: "lcj_1", version: 1, publishedAt: new Date(T0 - DAY).toISOString() });
    await record(db, { action: "lifecycle_journey.draft", draft: { kind: "lifecycle_journey", ref: "lcj_1" }, href: "/x" });
    expect(await run(db)).toEqual({ read: 1, closed: 0 });
  });

  it("closes a launch's welcome emails turned on as acted, a sent wave as acted and a cancelled one as stale", async () => {
    const db = new FakeFirestore();
    db.seed("journeys", "journey_camp1", { tenantId: "ten_A", campaignId: "camp1", status: "active", graph: { nodes: [], edges: [] } });
    db.seed("invite_waves", "wav_sent", { tenantId: "ten_A", campaignId: "camp1", status: "sent" });
    db.seed("invite_waves", "wav_off", { tenantId: "ten_A", campaignId: "camp1", status: "cancelled" });
    await record(db, { action: "launch_journey.draft", draft: { kind: "launch_journey", ref: "journey_camp1" }, launchId: "camp1", href: "/x" });
    await record(db, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_sent" }, launchId: "camp1", href: "/x" });
    await record(db, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_off" }, launchId: "camp1", href: "/x" });
    await run(db);
    const byRef = new Map((await records(db)).map((a) => [a.draft!.ref, a]));
    expect(stateOf(byRef.get("journey_camp1"))).toEqual(["acted", null, "system"]);
    expect(stateOf(byRef.get("wav_sent"))).toEqual(["acted", null, "system"]);
    expect(stateOf(byRef.get("wav_off"))).toEqual(["declined", "stale", "system"]);
  });

  it("closes a plan Found live approved as acted, and one in an archived programme as stale", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog" });
    db.seed("workspaces", "ws_old", { tenantId: "ten_A", name: "Old", archivedAt: "2026-11-01T00:00:00.000Z" });
    db.seed("workspaces/ws1/content_plans", "pl_live", samplePlan({ id: "pl_live" }, sampleHub({ status: "approved" })));
    db.seed("workspaces/ws1/content_plans", "pl_wait", samplePlan({ id: "pl_wait" }));
    db.seed("workspaces/ws_old/content_plans", "pl_old", samplePlan({ id: "pl_old", workspaceId: "ws_old" }));
    for (const [ws, id] of [["ws1", "pl_live"], ["ws1", "pl_wait"], ["ws_old", "pl_old"]]) {
      await record(db, { action: "autopilot.draft", draft: { kind: "content_plan", ref: planRef(ws!, id!) }, href: "/x" });
    }
    await run(db);
    const byRef = new Map((await records(db)).map((a) => [a.draft!.ref, a]));
    expect(stateOf(byRef.get("ws1:pl_live"))).toEqual(["acted", null, "system"]);
    expect(stateOf(byRef.get("ws1:pl_wait"))).toEqual(["proposed", null, null]);
    expect(stateOf(byRef.get("ws_old:pl_old"))).toEqual(["declined", "stale", "system"]);
  });

  it("closes a style suggestion replaced with no record of it as stale, and leaves the current one", async () => {
    const db = new FakeFirestore();
    const old = "2026-12-01T09:00:00.000Z";
    const now = "2026-12-01T09:30:00.000Z";
    db.seed("tenants", "ten_A", {
      tenantName: "Example Co",
      rootDomain: "example.com",
      status: "active",
      region: "us",
      allowedOrigins: ["https://example.com"],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      emailStyleSuggestion: { logoId: null, companyName: null, headerColor: "#225533", accentColor: "#aa3300", source: "chat", brief: "", notes: [], suggestedBy: "usr_a1", suggestedAt: now },
    });
    // Two open at once only after a supersede failed: each is a draft ref of its own here.
    await record(db, { action: "email_style.suggest", draft: { kind: "email_style", ref: "ten_A_old" }, keyPart: styleKeyPart(old), href: "/x" });
    await record(db, { action: "email_style.suggest", draft: { kind: "email_style", ref: "ten_A" }, keyPart: styleKeyPart(now), href: "/x" });
    await run(db);
    const byRef = new Map((await records(db)).map((a) => [a.draft!.ref, a]));
    expect(stateOf(byRef.get("ten_A_old"))).toEqual(["declined", "stale", "system"]);
    expect(stateOf(byRef.get("ten_A"))).toEqual(["proposed", null, null]);
  });

  it("closes a note kept elsewhere as acted, a removed one as stale, and a learning run that failed as stale", async () => {
    const db = new FakeFirestore();
    db.seed("brand_notes", "bn_kept0000", { tenantId: "ten_A", status: "kept", text: "x" });
    db.seed("repo_analyses", "ra_1", { tenantId: "ten_A", connectionId: "pcn_1", status: "failed" });
    await record(db, { action: "brand_note.suggest", draft: { kind: "brand_note", ref: "bn_kept0000" }, href: "/x" });
    await record(db, { action: "brand_note.suggest", draft: { kind: "brand_note", ref: "bn_gone0000" }, href: "/x" });
    await record(db, { action: "product_map.learn", draft: { kind: "repo_map", ref: "pcn_1" }, href: "/x", run: "ra_1" });
    await run(db);
    const byRef = new Map((await records(db)).map((a) => [a.draft!.ref, a]));
    expect(stateOf(byRef.get("bn_kept0000"))).toEqual(["acted", null, "system"]);
    expect(stateOf(byRef.get("bn_gone0000"))).toEqual(["declined", "stale", "system"]);
    expect(stateOf(byRef.get("pcn_1"))).toEqual(["declined", "stale", "system"]);
  });

  it("closes a map run whose suggestions all went to the dismissed list as dismissed, and one with some accepted as acted", async () => {
    const db = new FakeFirestore();
    db.seed("brand_maps", "bm_ten_A", { tenantId: "ten_A", rev: 0, suggestions: [], dismissed: ["k_one", "k_two"] });
    await recordMapRun(A, { action: "brand_map.suggest", keys: ["k_one", "k_two"], refs: [] }, { db, nowMs: T0 });
    await recordMapRun(A, { action: "brand_map.research", keys: ["k_one", "k_three"], refs: [] }, { db, nowMs: T0 + 1 });
    await run(db);
    const rows = await records(db);
    expect(stateOf(rows.find((a) => a.action === "brand_map.suggest"))).toEqual(["declined", "dismissed", "system"]);
    expect(rows.find((a) => a.action === "brand_map.research")).toMatchObject({ state: "acted", result: { kept: 1, dismissed: 1 } });
  });

  it("reads nothing once its budget has gone", async () => {
    const db = new FakeFirestore();
    await record(db, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_1" }, launchId: "camp1", href: "/x" });
    const at = T0 + DAY;
    expect(await catchUpBrand(A, { deadlineMs: at, db, now: () => at })).toEqual({ read: 0, closed: 0 });
  });
});
