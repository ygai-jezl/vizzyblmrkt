import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { saveFieldListChange, readFieldList } from "@/lib/audience/fieldList";
import { fieldTag } from "@/lib/audience/fieldTags";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { TenantContext } from "@/lib/tenant/types";
import { ARCHIVED_COLUMN, boardPaths, boardRequest, cardOf, moveRequest, readPipeline, sortCards, type BoardCard, type BoardColumn } from "./board";
import { boardWorld, type BoardWorld } from "./testing/world";

const NOW = new Date("2026-11-26T09:00:00.000Z");
const loadTenant = async () => ({ id: "ten_a", timeZone: "Europe/London" }) as never;
const member: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_member", role: "member" };

let db: FakeFirestore;
let w: BoardWorld;
const deps = () => ({ db, loadTenant, now: () => NOW });
const read = async (cap = 300) => {
  const r = await readPipeline(w.ctx, { cap }, deps());
  if (!r.setUp) throw new Error("not set up");
  return r;
};
const column = (cols: BoardColumn[], label: string) => cols.find((c) => c.label === label)!;
const events = () => db.dump("ontology_events");

beforeEach(async () => {
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  w = await boardWorld(db);
});
afterEach(() => vi.unstubAllEnvs());

describe("readPipeline", () => {
  it("isn't set up without a Stage field", async () => {
    const empty = new FakeFirestore();
    expect(await readPipeline(w.ctx, { cap: 300 }, { db: empty, loadTenant, now: () => NOW })).toEqual({ setUp: false });
  });

  it("draws a column per stage in the field's order, with exact counts", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted" });
    await w.add({ email: "priya@example.test", stage: "contacted" });
    await w.add({ email: "lee@example.com", stage: "passed", reason: "crowded" });
    await w.add({ email: "nobody@example.com" });
    const r = await read();
    expect(r.columns.map((c) => [c.label, c.count])).toEqual([
      ["Research", 0],
      ["Contacted", 2],
      ["Replied", 0],
      ["First meeting", 0],
      ["Next meeting", 0],
      ["Diligence", 0],
      ["Term sheet", 0],
      ["Committed (a promise)", 0],
      ["Money in", 0],
      ["Passed", 1],
    ]);
    expect(r.columns.map((c) => c.role)).toEqual(["open", "active", "active", "active", "active", "active", "active", "active", "won", "passed"]);
    expect(r.totals).toMatchObject({ people: 3, capped: false });
    expect(r.kind).toBe("raising");
    expect(r.today).toBe("2026-11-26");
  });

  it("puts archived stages that still hold people in one trailing column", async () => {
    await w.add({ email: "sam@example.com", stage: "replied" });
    await w.add({ email: "priya@example.test", stage: "diligence" });
    const list = await readFieldList(w.ctx, "person", db);
    for (const preset of ["replied", "diligence", "term_sheet"]) {
      const cur = await readFieldList(w.ctx, "person", db);
      await saveFieldListChange(w.ctx, "person", { baseRev: cur.rev, change: { op: "archive_option", key: w.ids.stage, optionId: w.stage(preset) }, by: { type: "member", id: "u_admin" } }, db);
    }
    expect(list.rev).toBe(1);
    const r = await read();
    expect(r.columns.map((c) => c.label)).not.toContain("Replied");
    const last = r.columns.at(-1)!;
    expect(last).toMatchObject({ optionId: ARCHIVED_COLUMN, label: "No longer in use", role: "archived", count: 2 });
    expect(last.cards).toHaveLength(2);
  });

  it("shows a card's name, firm, tier, dates, reason and what is due", async () => {
    const sam = await w.add({ email: "sam@example.com", first: "Sam", last: "Okafor", stage: "contacted", firm: "Fern Capital", tier: "a", lastTouch: "2026-11-10", nextStepDate: "2026-11-20" });
    const priya = await w.add({ email: "priya@example.test", stage: "passed", reason: "price_terms" });
    const r = await read();
    const card = column(r.columns, "Contacted").cards[0]!;
    expect(card).toEqual({
      id: sam,
      name: "Sam Okafor",
      email: null,
      firm: "Fern Capital",
      tier: "A",
      nextStepDate: "2026-11-20",
      lastTouch: "2026-11-10",
      stageOptionId: w.stage("contacted"),
      passReason: null,
      due: ["quiet", "next_step"],
      quietDays: 16,
      followUp: false,
    });
    const passed = column(r.columns, "Passed").cards[0]!;
    expect(passed).toMatchObject({ id: priya, name: null, email: "priya@example.test", passReason: { optionId: w.reason("price_terms"), key: "price_terms", label: "Price or terms" }, due: [] });
    expect(r.totals).toMatchObject({ quiet: 1, nextStepPast: 1, overdue: 1 });
  });

  it("marks the people with an open follow-up", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const r = await readPipeline(w.ctx, { cap: 300 }, { ...deps(), openFollowUps: async () => new Set([sam]) });
    if (!r.setUp) throw new Error("not set up");
    expect(column(r.columns, "Contacted").cards[0]!.followUp).toBe(true);
  });

  it("reads at most the cap a stage, the most recently active, and says it is capped", async () => {
    await w.add({ email: "a@example.com", stage: "contacted", activeAt: "2026-11-01T00:00:00.000Z" });
    await w.add({ email: "b@example.com", stage: "contacted", activeAt: "2026-11-03T00:00:00.000Z" });
    await w.add({ email: "c@example.com", stage: "contacted", activeAt: "2026-11-02T00:00:00.000Z" });
    const r = await read(2);
    const col = column(r.columns, "Contacted");
    expect(col).toMatchObject({ count: 3, capped: true });
    expect(col.cards.map((c) => c.email)).toEqual(["b@example.com", "c@example.com"]);
    expect(r.totals.capped).toBe(true);
  });

  it("never shows another brand's people", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted" });
    const other = deterministicContactId("ten_b", "lee@example.com");
    db.seed("contacts", other, { tenantId: "ten_b", memberOf: ["all", fieldTag(w.ids.stage, w.stage("contacted"))], sortKey: `2026-11-20T00:00:00.000Z|${other}`, email: "lee@example.com" });
    const r = await read();
    expect(column(r.columns, "Contacted")).toMatchObject({ count: 1 });
    expect(JSON.stringify(r.columns)).not.toContain("lee@example.com");
  });

  it("reads only names, address, order, tags and the six values", () => {
    expect(boardPaths(w.rf)).toEqual([
      "firstName",
      "lastName",
      "email",
      "sortKey",
      "memberOf",
      `fields.${w.ids.stage}`,
      `fields.${w.ids.passReason}`,
      `fields.${w.ids.firm}`,
      `fields.${w.ids.tier}`,
      `fields.${w.ids.lastTouch}`,
      `fields.${w.ids.nextStepDate}`,
    ]);
  });
});

describe("cards", () => {
  it("sort by Next step date, soonest first, none last, ties in the list's order", () => {
    const c = (id: string, nextStepDate: string | null) => ({ id, nextStepDate }) as BoardCard;
    expect(sortCards([c("1", null), c("2", "2026-12-03"), c("3", "2026-11-30"), c("4", null), c("5", "2026-11-30")]).map((x) => x.id)).toEqual(["3", "5", "2", "1", "4"]);
  });

  it("read a team's own option as in play", () => {
    const card = cardOf({ id: "ct_1", fields: { [w.ids.stage]: "opt_unknown1", [w.ids.lastTouch]: "2026-11-01" } }, w.rf, "2026-11-26");
    expect(card.due).toEqual(["quiet"]);
  });
});

describe("boardRequest", () => {
  it("answers the board with who may move, the fields and the reasons", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted" });
    const admin = await boardRequest(w.ctx, deps());
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ setUp: true, kinds: ["raising"], tab: "Investors", noun: { one: "investor", many: "investors" }, canMove: true, followUps: false, quietAfterDays: 14 });
    const body = admin.body as { fields: Record<string, { id: string; label: string }>; reasonOptions: unknown[]; totals: unknown };
    expect(body.fields.stage).toEqual({ id: w.ids.stage, label: "Stage" });
    expect(body.reasonOptions).toHaveLength(23);
    expect(body.totals).toEqual({ people: 1, quiet: 0, nextStepPast: 0, capped: false });
    expect((await boardRequest(member, deps())).body).toMatchObject({ canMove: false });
  });

  it("names a funding board Funding", async () => {
    const funding = new FakeFirestore();
    const f = await boardWorld(funding, { kit: "funding" });
    expect((await boardRequest(f.ctx, { db: funding, loadTenant, now: () => NOW })).body).toMatchObject({ tab: "Funding", noun: { one: "lender or funder", many: "lenders and funders" } });
  });

  it("says when there is no board", async () => {
    expect((await boardRequest(w.ctx, { db: new FakeFirestore(), loadTenant })).body).toEqual({ setUp: false });
  });
});

describe("moveRequest", () => {
  const move = (body: unknown, extra = {}) => moveRequest(w.ctx, body, { ...deps(), ...extra });

  it("moves a card with an event on their timeline", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const before = events().length;
    const r = await move({ personId: sam, from: w.stage("contacted"), to: w.stage("first_meeting") });
    expect(r.status).toBe(200);
    expect((r.body as { card: BoardCard }).card).toMatchObject({ id: sam, stageOptionId: w.stage("first_meeting") });
    const fresh = events().slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: "record.field_changed", fieldId: w.ids.stage, personId: sam });
    expect(db.raw("contacts", sam)!.memberOf).toContain(fieldTag(w.ids.stage, w.stage("first_meeting")));
  });

  it("logs a reason onto Passed, leaves it blank, and clears it when they leave Passed", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "diligence" });
    await move({ personId: sam, from: w.stage("diligence"), to: w.stage("passed"), reason: w.reason("crowded") });
    expect(db.raw("contacts", sam)!.fields).toMatchObject({ [w.ids.stage]: w.stage("passed"), [w.ids.passReason]: w.reason("crowded") });
    await move({ personId: sam, from: w.stage("passed"), to: w.stage("replied") });
    expect((db.raw("contacts", sam)!.fields as Record<string, unknown>)[w.ids.passReason]).toBeUndefined();
    await move({ personId: sam, from: w.stage("replied"), to: w.stage("passed"), reason: null });
    expect((db.raw("contacts", sam)!.fields as Record<string, unknown>)[w.ids.passReason]).toBeUndefined();
    expect((db.raw("contacts", sam)!.fields as Record<string, unknown>)[w.ids.stage]).toBe(w.stage("passed"));
  });

  it("answers stale, writing nothing, when the card showed another stage", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const before = JSON.stringify(db.raw("contacts", sam));
    const r = await move({ personId: sam, from: w.stage("replied"), to: w.stage("first_meeting") });
    expect(r).toEqual({ status: 409, body: { error: "stale" } });
    expect(JSON.stringify(db.raw("contacts", sam))).toBe(before);
    const none = await move({ personId: sam, from: null, to: w.stage("first_meeting") });
    expect(none.status).toBe(409);
  });

  it("refuses bad input, a stage that isn't live and a reason not in the list", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    expect((await move({ personId: sam, to: w.stage("replied") })).status).toBe(400);
    expect((await move({ personId: "sam", from: null, to: w.stage("replied") })).status).toBe(400);
    expect((await move({ personId: sam, from: w.stage("contacted"), to: "opt_nothere1" })).body).toEqual({ error: "invalid_value" });
    expect((await move({ personId: sam, from: w.stage("contacted"), to: w.stage("passed"), reason: w.stage("replied") })).body).toEqual({ error: "invalid_value" });
  });

  it("finds nobody for another brand's person or someone gone, and says when there is no board", async () => {
    const other = deterministicContactId("ten_b", "lee@example.com");
    db.seed("contacts", other, { tenantId: "ten_b", memberOf: ["all"] });
    expect(await move({ personId: other, from: null, to: w.stage("replied") })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(db.raw("contacts", other)).toEqual({ tenantId: "ten_b", memberOf: ["all"] });
    expect((await move({ personId: deterministicContactId("ten_a", "gone@example.com"), from: null, to: w.stage("replied") })).status).toBe(404);
    const sam = await w.add({ email: "sam@example.com" });
    const bare = new FakeFirestore();
    bare.seed("contacts", sam, { tenantId: "ten_a", memberOf: ["all"] });
    expect(await moveRequest(w.ctx, { personId: sam, from: null, to: w.stage("replied") }, { db: bare, loadTenant })).toEqual({ status: 400, body: { error: "not_set_up" } });
  });

  it("sets the person's open follow-ups aside as it moves them, with follow-ups on", async () => {
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    const { followUpProposal } = await import("./followups");
    const { proposeAgentAction } = await import("@/lib/tenant");
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    const fu = await proposeAgentAction(
      w.ctx,
      followUpProposal({ personId: sam, due: "quiet", day: "2026-11-01", stageOptionId: w.stage("contacted"), stageField: w.ids.stage, dateField: w.ids.lastTouch, at: NOW.toISOString() }),
      { db },
    );
    const board = await boardRequest(w.ctx, deps());
    const contacted = (board.body as { columns: BoardColumn[] }).columns.find((c) => c.label === "Contacted")!;
    expect(contacted.cards[0]!.followUp).toBe(true);
    const r = await move({ personId: sam, from: w.stage("contacted"), to: w.stage("replied") });
    expect((r.body as { card: BoardCard }).card.followUp).toBe(false);
    expect(db.raw("agent_actions", fu.action.id)).toMatchObject({ state: "declined", declined: { reason: "stale" } });
  });

  it("tells whoever clears follow-ups which fields changed", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const afterMove = vi.fn(async () => null);
    await move({ personId: sam, from: w.stage("contacted"), to: w.stage("replied") }, { afterMove });
    expect(afterMove).toHaveBeenCalledWith(w.ctx, sam, [w.ids.stage]);
  });
});
