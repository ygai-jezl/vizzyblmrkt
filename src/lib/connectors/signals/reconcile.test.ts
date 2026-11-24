import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, proposeAgentAction, type TenantContext } from "@/lib/tenant";
import { agentDedupeKey, AgentActionSchema, type AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ACTION, SIGNALS_AGENT, SIGNALS_REVIEW_HREF } from "./names";
import { expireConnectorSignals, reconcileProposals, withdrawProposedBy } from "./reconcile";
import { detectConnection } from "./detect";
import { seedSearchConsole, search, writeDays } from "../testing/signals";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";

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

describe("brand map proposals from rising searches", () => {
  const CONN = "dcn_ssssssssssssssssssss";
  beforeEach(() => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  });

  /** A map with one subject, and `n` rising searches proposed as questions under it. */
  async function proposed(n: number): Promise<string[]> {
    const { ensureMoved } = await import("@/lib/brandMap/move");
    const { createSubject } = await import("@/lib/brandMap/records");
    await ensureMoved(A, { db, nowMs: NOW.getTime() });
    await createSubject(A, { name: "Pet safe plants" }, { db, nowMs: NOW.getTime() });
    await seedSearchConsole(A, db, CONN);
    await writeDays(A, db, CONN, "topic", 28, (_d, i) => (i >= 14 ? Array.from({ length: n }, (_, k) => search(`pet safe search ${["one", "two", "three", "four"][k]}`, 10)) : []));
    const conn = (await forTenant(A, db).dataConnections.getById(CONN))!;
    await detectConnection(A, conn, [], { db, now: NOW, embed: async (items) => items.map(() => null) });
    const qs = await brandMapRecords(A, db).find("q", { where: [["fromConnectionId", "==", CONN]] });
    return qs.map((q) => String(q.ref)).sort();
  }
  const actionFor = async (qid: string) => (await actions()).find((a) => a.target.id === qid)!;
  const question = (qid: string) => brandMapRecords(A, db).get("q", qid);

  it("moves each open proposal with its question: decided acted, dismissed declined, merged or gone superseded", async () => {
    const [q1, q2, q3, q4] = await proposed(4);
    const { decideProposals } = await import("@/lib/brandMap/proposals");
    const { removeQuestion } = await import("@/lib/brandMap/records");
    await decideProposals(A, { accept: { questions: [q1!] }, dismiss: { questions: [q2!] } }, { db, nowMs: NOW.getTime() });
    await removeQuestion(A, q3!, { db });
    await brandMapRecords(A, db).claim("q", q4!, () => ({ status: "dismissed", mergedInto: "q_aaaaaaaaaaaaaaaaaaaa" }));
    expect(await reconcileProposals(A, [CONN], { db, now: NOW })).toEqual({ acted: 1, declined: 3, withdrawn: 0 });
    expect(await actionFor(q1!)).toMatchObject({ state: "acted", proposal: null, result: { questionId: q1 } });
    expect(await actionFor(q2!)).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null });
    expect(await actionFor(q3!)).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
    expect(await actionFor(q4!)).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
    // A decided question stays on the map with its tag.
    expect(await question(q1!)).toMatchObject({ status: "decided", from: "search_console" });
  });

  it("withdraws a question still undecided when its 30 days end, whether this lane or another closed its action", async () => {
    const [q1, q2] = await proposed(2);
    // Another expiry (the lifecycle tick's) closed q2's action already.
    const a2 = await actionFor(q2!);
    const { transitionAgentAction } = await import("@/lib/tenant");
    await transitionAgentAction(A, a2.id, { to: "declined", reason: "expired", by: { type: "system", id: "agent_action_expiry" }, at: new Date(NOW.getTime() + 30 * DAY).toISOString() }, { db });
    expect(await reconcileProposals(A, [CONN], { db, now: new Date(NOW.getTime() + 10 * DAY) })).toEqual({ acted: 0, declined: 0, withdrawn: 0 });
    const r = await reconcileProposals(A, [CONN], { db, now: new Date(NOW.getTime() + 30 * DAY + 1000) });
    expect(r).toEqual({ acted: 0, declined: 1, withdrawn: 2 });
    expect(await question(q1!)).toBeNull();
    expect(await question(q2!)).toBeNull();
    expect(await actionFor(q1!)).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null });
  });

  it("withdraws a connection's undecided questions on erase and keeps the decided ones", async () => {
    const [q1, q2] = await proposed(2);
    const { decideProposals } = await import("@/lib/brandMap/proposals");
    await decideProposals(A, { accept: { questions: [q1!] } }, { db, nowMs: NOW.getTime() });
    expect(await withdrawProposedBy(A, CONN, "all", { db, now: NOW })).toBe(1);
    expect(await question(q1!)).toMatchObject({ status: "decided" });
    expect(await question(q2!)).toBeNull();
    // Withdrawn words may be proposed again later: nothing dismissed blocks them.
    expect((await brandMapRecords(A, db).find("q", { where: [["status", "==", "dismissed"]] })).length).toBe(0);
  });
});
