import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { proposeAgentAction, type TenantContext } from "@/lib/tenant";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { draftNewPerson } from "@/lib/audience/personDrafts";
import { agentDedupeKey, type AgentActionId } from "@/lib/types/agentAction";
import { runLifecycleTick } from "./runner";

/**
 * Agent actions past their expiry, on the scheduler's tick (piece B, group 11): declined whenever
 * person links are on, not behind a Vizzy switch, and a New person draft's typed details go with
 * it. Made-up people at example.com.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T07:00:00.000Z");
const admin: TenantContext = { tenantId: "ten_A", region: "eu", source: "agent", userId: "u_admin", role: "admin" };

const tick = (db: FakeFirestore, opts: { now?: () => number; budgetMs?: number } = {}) =>
  runLifecycleTick(
    { db, now: opts.now ?? (() => NOW), budgetMs: opts.budgetMs, listTenants: async () => [{ id: "ten_A", region: "eu" } as never], send: async () => ({ ok: true }) as never },
    { product: false, waitlist: false },
  );

async function oldDraft(db: FakeFirestore, email: string, ageDays: number) {
  const r = await draftNewPerson(admin, { email, firstName: "Lee" }, { db, nowMs: NOW - ageDays * DAY });
  if (!r.ok || r.outcome === "existing") throw new Error("not drafted");
  return r.action.id;
}

beforeEach(() => {
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  // Every Vizzy switch off: expiry runs whatever they say.
  vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
  vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("agent action expiry on the tick", () => {
  it("declines a draft past its 7 days and clears what was typed, and leaves a younger one", async () => {
    const db = new FakeFirestore();
    const old = await oldDraft(db, "lee.park@example.com", 8);
    const young = await oldDraft(db, "jo.ng@example.com", 2);
    const r = await tick(db);
    expect(r.expiredActions).toBe(1);
    expect(await getAgentAction(admin, old as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null, decidedBy: { type: "system" } });
    expect(JSON.stringify(db.dump("agent_actions"))).not.toContain("lee.park@example.com");
    expect(await getAgentAction(admin, young as AgentActionId, { db })).toMatchObject({ state: "proposed", proposal: { person: { email: "jo.ng@example.com" } } });
  });

  it("declines any agent's expired suggestion, keeping a field suggestion's values", async () => {
    const db = new FakeFirestore();
    const person = "ct_" + "b".repeat(40);
    const { action } = await proposeAgentAction(
      admin,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", "old"),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: person },
        personId: person as `ct_${string}`,
        proposal: { fields: { fld_aaaaaaaaaaa1: 3 } },
        basis: { fields: { fld_aaaaaaaaaaa1: 2 } },
        fieldIds: ["fld_aaaaaaaaaaa1"],
        signals: [],
        review: null,
        requestedBy: { type: "member", id: "u_admin" },
        expiresAt: new Date(NOW - DAY).toISOString(),
        at: new Date(NOW - 31 * DAY).toISOString(),
      },
      { db },
    );
    expect((await tick(db)).expiredActions).toBe(1);
    expect(await getAgentAction(admin, action.id, { db })).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: { fields: { fld_aaaaaaaaaaa1: 3 } } });
  });

  it("doesn't run with person links off, and stays inside the run's deadline", async () => {
    const db = new FakeFirestore();
    const old = await oldDraft(db, "lee.park@example.com", 8);
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    expect((await tick(db)).expiredActions).toBeUndefined();
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    // The clock is past the deadline by the time the expiry would start: it waits for the next tick.
    let calls = 0;
    const late = () => (calls++ < 2 ? NOW : NOW + 10 * 60_000);
    expect((await tick(db, { now: late, budgetMs: 60_000 })).expiredActions).toBe(0);
    expect(await getAgentAction(admin, old as AgentActionId, { db })).toMatchObject({ state: "proposed" });
  });
});
