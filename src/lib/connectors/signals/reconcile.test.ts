import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, proposeAgentAction, type TenantContext } from "@/lib/tenant";
import { agentDedupeKey, AgentActionSchema, type AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ACTION, SIGNALS_AGENT, SIGNALS_REVIEW_HREF } from "./names";
import { expireConnectorSignals } from "./reconcile";

// Housekeeping for suggestions from collected numbers: expiry declines this agent's suggestions
// past their 30 days, values cleared, whatever the switches say. Every id and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const NOW = new Date("2026-11-23T10:00:00.000Z");
const DAY = 86_400_000;
const SIG = (n: number) => `dsg_${String(n).padStart(24, "0")}`;

let db: FakeFirestore;
const actions = async () => (await forTenant(A, db).agentActions.find()).map((a) => AgentActionSchema.parse(a) as AgentAction);

/** A suggestion proposed `daysAgo` days ago that expires 30 days after. */
async function suggestion(ctx: TenantContext, fdb: FakeFirestore, n: number, daysAgo: number, agent: "connector_signals" | "vizzy" = SIGNALS_AGENT) {
  const at = new Date(NOW.getTime() - daysAgo * DAY);
  return proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey(DATA_SIGNAL_ACTION, SIG(n), "r1"),
      agent,
      action: DATA_SIGNAL_ACTION,
      target: { type: "data_signal", id: SIG(n) },
      personId: null,
      proposal: { rule: "losing_page", connectionId: "dcn_ssssssssssssssssssss", gen: 0, label: "/care/fiddle-leaf-fig", numbers: { searchClicks: 41 } },
      basis: null,
      signals: [{ kind: "data_signal", ref: SIG(n) }],
      review: { kind: "data_signal", href: SIGNALS_REVIEW_HREF },
      requestedBy: { type: "system", id: SIGNALS_AGENT },
      expiresAt: new Date(at.getTime() + 30 * DAY).toISOString(),
      clearDetailsOnClose: true,
      at: at.toISOString(),
    },
    { db: fdb },
  );
}

beforeEach(() => {
  db = new FakeFirestore();
});
afterEach(() => vi.unstubAllEnvs());

describe("expiring suggestions from collected numbers", () => {
  it("declines this agent's suggestions past their 30 days, values cleared, and leaves the rest", async () => {
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    await suggestion(A, db, 1, 31);
    await suggestion(A, db, 2, 5);
    await suggestion(A, db, 3, 40, "vizzy");
    expect(await expireConnectorSignals(A, { db, now: NOW })).toEqual({ expired: 1 });
    const byTarget = Object.fromEntries((await actions()).map((a) => [a.target.id, a]));
    expect(byTarget[SIG(1)]).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null, decidedBy: { type: "system", id: SIGNALS_AGENT } });
    expect(byTarget[SIG(2)]).toMatchObject({ state: "proposed" });
    // Another agent's are the lifecycle tick's to expire.
    expect(byTarget[SIG(3)]).toMatchObject({ state: "proposed" });
    expect(await expireConnectorSignals(A, { db, now: NOW })).toEqual({ expired: 0 });
  });
});
