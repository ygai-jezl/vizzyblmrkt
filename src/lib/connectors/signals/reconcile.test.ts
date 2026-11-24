import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, proposeAgentAction, type TenantContext } from "@/lib/tenant";
import { agentDedupeKey, AgentActionSchema, type AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ACTION, SIGNALS_AGENT, SIGNALS_REVIEW_HREF } from "./names";
import { blankDismissedFrom, closeAllSuggestions, expireConnectorSignals, reconcileProposals, withdrawProposedBy } from "./reconcile";
import { setGrants } from "../service";
import { laneHousekeeping } from "../collect/tick";
import { nextUpDocId } from "@/lib/types/autopilot";
import { NOT_SHARED_NEXT_UP } from "./planning";
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

describe("closing every suggestion before a revert", () => {
  it("counts in a dry run, then declines each with its values cleared", async () => {
    await suggestion(A, db, 4, 2);
    await suggestion(A, db, 5, 3);
    await suggestion(A, db, 6, 3, "vizzy");
    expect(await closeAllSuggestions(A, { db, now: NOW, apply: false })).toEqual({ open: 2, closed: 0, withdrawn: 0 });
    expect((await actions()).filter((a) => a.state === "proposed")).toHaveLength(3);
    expect(await closeAllSuggestions(A, { db, now: NOW, apply: true })).toEqual({ open: 2, closed: 2, withdrawn: 0 });
    const mine = (await actions()).filter((a) => a.agent === SIGNALS_AGENT);
    expect(mine.every((a) => a.state === "declined" && a.proposal === null)).toBe(true);
    expect(await closeAllSuggestions(A, { db, now: NOW, apply: false })).toEqual({ open: 0, closed: 0, withdrawn: 0 });
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

  it("withdraws what a connection fed planning once members can't read it: proposals, suggestions and Next up picks", async () => {
    const [q1, q2] = await proposed(2);
    const { decideProposals } = await import("@/lib/brandMap/proposals");
    await decideProposals(A, { accept: { questions: [q1!] } }, { db, nowMs: NOW.getTime() });
    await suggestion(A, db, 7, 1);
    // A stored Next up pick that weighed Search Console, and one that didn't.
    await forTenant(A, db).nextUp.upsert(
      nextUpDocId(A.tenantId),
      () => ({
        picks: [
          { questionId: "q_sc000000000000000", question: "How often should I water a monstera?", subjectId: "sub_water0000000", subjectName: "Watering", because: "It has 1,900 impressions.", chips: [{ kind: "num", label: "Search Console", text: "1,900 impressions, position 8.6" }], from: "gemini" },
          { questionId: "q_other00000000000", question: "Which plants are safe for cats?", subjectId: "sub_pets00000000", subjectName: "Pet safe plants", because: "No article answers it yet.", chips: [{ kind: "map", label: "Brand map", text: "1 of 4 answered" }], from: "gemini" },
        ],
        notOnMap: [],
        missing: [],
        candidates: 2,
        at: NOW.toISOString(),
        by: "schedule",
      }),
      () => null,
    );
    const admin = { kind: "human" as const, uid: "usr_admin", role: "admin" as const };
    // Admins and Vizzy only: members lose the grant, so the whole team's views must drop it.
    const r = await setGrants(A, admin, CONN, { grants: [{ to: "agent:vizzy", can: "read" }] }, { db, now: NOW, log: () => {} });
    expect(r.ok).toBe(true);
    expect(await question(q1!)).toMatchObject({ status: "decided" });
    expect(await question(q2!)).toBeNull();
    expect(await actionFor(q2!)).toMatchObject({ state: "declined", declined: { reason: "stale" }, proposal: null });
    expect((await actions()).find((a) => a.target.id === SIG(7))).toMatchObject({ state: "declined", declined: { reason: "stale" }, proposal: null });
    const stored = await forTenant(A, db).nextUp.getById(nextUpDocId(A.tenantId));
    expect(stored!.picks.map((p) => p.questionId)).toEqual(["q_other00000000000"]);
    expect(stored!.missing).toContain(NOT_SHARED_NEXT_UP);
  });

  it("lets the lane withdraw what a connection not feeding planning still has open, if the first try failed", async () => {
    const [q1] = await proposed(1);
    await suggestion(A, db, 8, 1);
    // The grant went by a path that didn't withdraw anything.
    await forTenant(A, db).dataConnections.getById(CONN);
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(A, CONN, () => ({ patch: { grants: [] }, activity: [] }), db);
    const conn = (await forTenant(A, db).dataConnections.getById(CONN))!;
    await laneHousekeeping(A, [conn], { db, now: NOW });
    expect(await question(q1!)).toBeNull();
    expect((await actions()).find((a) => a.target.id === SIG(8))).toMatchObject({ state: "declined", declined: { reason: "stale" } });
  });

  it("takes the search's words and numbers off a dismissed question on erase, keeping its own words", async () => {
    const [q1, q2] = await proposed(2);
    const { decideProposals } = await import("@/lib/brandMap/proposals");
    await decideProposals(A, { accept: { questions: [q1!] }, dismiss: { questions: [q2!] } }, { db, nowMs: NOW.getTime() });
    const before = await question(q2!);
    expect(before).toMatchObject({ status: "dismissed" });
    expect(String(before!.reason)).not.toBe("");
    expect(await blankDismissedFrom(A, CONN, { db, now: NOW })).toBe(1);
    expect(await question(q2!)).toMatchObject({ status: "dismissed", reason: "", evidence: "", text: before!.text });
    // A decided question keeps its tag and its reason.
    expect(String((await question(q1!))!.reason)).not.toBe("");
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
