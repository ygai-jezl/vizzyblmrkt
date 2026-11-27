import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import { setFieldValues } from "@/lib/audience/fields";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";
import { proposeAgentAction } from "@/lib/tenant";
import { agentRaisePipeline } from "./agentApi";
import { followUpProposal } from "./followups";
import { boardWorld, type BoardWorld } from "./testing/world";

const NOW = new Date("2026-11-26T09:00:00.000Z");
const loadTenant = async () => ({ id: "ten_a", timeZone: "Europe/London" }) as never;
type Body = Record<string, unknown> & {
  stages: Array<{ name: string; stage: string | null; role: string; stagePeople: number }>;
  passes: { passedPeople: number; reasons: Array<Record<string, unknown>>; ownReasons: Array<Record<string, unknown>>; noReasonPasses: number };
  followUps: Record<string, number>;
  meanings: Record<string, unknown>;
};

let db: FakeFirestore;
let w: BoardWorld;
const ask = async () => (await agentRaisePipeline(w.ctx, { db, loadTenant, now: () => NOW })).body as Body;

beforeEach(async () => {
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  w = await boardWorld(db);
});
afterEach(() => vi.unstubAllEnvs());

async function seedBoard() {
  const sam = await w.add({ email: "sam.okafor@example.com", first: "Sam", last: "Okafor", firm: "Fern Capital", stage: "contacted", lastTouch: "2026-11-01", nextStepDate: "2026-11-20" });
  await w.add({ email: "priya@example.test", firm: "Orchard Ventures", stage: "contacted", lastTouch: "2026-11-01" });
  await w.add({ email: "lee@example.com", stage: "research", nextStepDate: "2026-11-01" });
  await w.add({ email: "kim@example.com", stage: "first_meeting", lastTouch: "2026-11-24" });
  await w.add({ email: "a@example.com", stage: "passed", reason: "crowded" });
  await w.add({ email: "b@example.com", stage: "passed", reason: "crowded" });
  await w.add({ email: "c@example.com", stage: "passed", reason: "trading_history" });
  await w.add({ email: "d@example.com", stage: "passed", reason: "no_reason" });
  await w.add({ email: "e@example.com", stage: "passed" });
  // A team's own reason.
  const list = await readFieldList(w.ctx, "person", db);
  const saved = await saveFieldListChange(w.ctx, "person", { baseRev: list.rev, change: { op: "add_option", key: w.ids.passReason, label: "Wants a lead first" }, by: { type: "member", id: "u_admin" } }, db);
  if (!saved.ok) throw new Error(saved.error);
  const ownId = saved.list.items.find((f) => f.key === w.ids.passReason)!.options!.at(-1)!.id;
  const f = await w.add({ email: "f@example.com", stage: "passed" });
  await setFieldValues(w.ctx, { object: "person", recordId: f, changes: { [w.ids.passReason]: ownId }, by: { type: "member", id: "u_admin" }, source: "editor" }, { db });
  await w.add({ email: "g@example.com", stage: "money_in" });
  return { sam };
}

describe("agentRaisePipeline", () => {
  it("says when there is no board", async () => {
    const r = await agentRaisePipeline(w.ctx, { db: new FakeFirestore(), loadTenant });
    expect(r).toEqual({ status: 200, body: { status: "success", setUp: false, note: expect.stringContaining("Set up for raising") } });
  });

  it("counts people by stage and why they passed", async () => {
    await seedBoard();
    const body = await ask();
    expect(body).toMatchObject({ status: "success", setUp: true, board: "Investors", today: "2026-11-26", pipelinePeople: 11, capped: false });
    expect(body.stages.find((s) => s.stage === "contacted")).toEqual({ name: "Contacted", stage: "contacted", role: "in play", stagePeople: 2 });
    expect(body.stages.find((s) => s.stage === "research")).toMatchObject({ role: "not started", stagePeople: 1 });
    expect(body.stages.find((s) => s.stage === "money_in")).toMatchObject({ role: "money in", stagePeople: 1 });
    expect(body.passes).toEqual({
      passedPeople: 6,
      reasons: [
        { reason: "crowded", name: "Crowded market", area: "Market", reasonPasses: 2 },
        { reason: "trading_history", name: "Not enough trading history", area: "Deal", reasonPasses: 1 },
      ],
      ownReasons: [{ name: "Wants a lead first", reasonPasses: 1 }],
      noReasonPasses: 2,
    });
  });

  it("counts quiet and past their next step, each overdue person once", async () => {
    await seedBoard();
    const body = await ask();
    // Sam: both; Priya: quiet; Lee: next step past (not started); Kim: touched lately.
    expect(body.followUps).toEqual({ quietAfterDays: 14, quietPeople: 2, nextStepPastPeople: 2, overduePeople: 3 });
  });

  it("counts open follow-ups only while they are on", async () => {
    const { sam } = await seedBoard();
    await proposeAgentAction(
      w.ctx,
      followUpProposal({ personId: sam, due: "quiet", day: "2026-11-01", stageOptionId: w.stage("contacted"), stageField: w.ids.stage, dateField: w.ids.lastTouch, at: new Date().toISOString() }),
      { db },
    );
    expect((await ask()).followUps).not.toHaveProperty("openFollowUps");
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    expect((await ask()).followUps.openFollowUps).toBe(1);
  });

  it("gives every number its meaning, and never a name, an address or a firm", async () => {
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    await seedBoard();
    const body = await ask();
    const { meanings, ...rest } = body;
    const keys = numberKeys(rest);
    expect([...keys].sort()).toEqual(
      ["pipelinePeople", "stagePeople", "passedPeople", "reasonPasses", "noReasonPasses", "quietAfterDays", "quietPeople", "nextStepPastPeople", "overduePeople", "openFollowUps"].sort(),
    );
    for (const k of keys) {
      expect(Object.keys(MEANINGS), k).toContain(k);
      expect(meanings, k).toHaveProperty(k);
    }
    expect(JSON.stringify(body)).not.toMatch(/Sam|Okafor|example\.(com|test)|Fern|Orchard|ct_[0-9a-f]/);
  });

  it("says capped when a stage holds more than it reads", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted" });
    await w.add({ email: "priya@example.test", stage: "contacted" });
    const { readPipeline } = await import("./board");
    const read = await readPipeline(w.ctx, { cap: 1 }, { db, loadTenant, now: () => NOW });
    expect(read.setUp && read.totals.capped).toBe(true);
    expect((await ask()).capped).toBe(false);
  });
});
