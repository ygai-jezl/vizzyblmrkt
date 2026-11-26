import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { addPerson } from "@/lib/audience/addPerson";
import { parseNewPerson } from "@/lib/audience/newPerson";
import { deterministicCompanyId } from "@/lib/crm/identifiers";
import { ctx, seedWorld, T0, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import type { AgentAction } from "@/lib/types/agentAction";
import { cleanSource, dismissPasteBatch, readPaste, readPasteBatch } from "./batch";
import { PASTE_ACTION } from "./review";
import { DONE_WHEN_TSV, KIT_TSV } from "./testing/samples";
import { addField, F, optionId } from "./testing/world";

const DAY = 86_400_000;
const actions = (db: FakeFirestore) => db.dump("agent_actions") as unknown as AgentAction[];
const other = { ...ctx, tenantId: "ten_other", userId: "usr_9" };

async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  return db;
}

describe("readPaste", () => {
  it("saves one card for 10 people and 3 firms, and leaves out a name only by its row", async () => {
    const db = await world();
    const r = await readPaste(ctx, { text: DONE_WHEN_TSV, source: "  Our  advisers'\nsheet ", from: "box" }, { db, nowMs: T0 });
    if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
    expect(r.batch.counts).toEqual({ read: 14, people: 10, companies: 3, left: 1, already: 0 });
    expect(r.skipped).toEqual([{ row: 15, reason: "no_contact" }]);
    expect(r.batch.source).toBe("Our advisers' sheet");
    expect(r.batch.rows[0]).toEqual({ row: 2, kind: "person", name: "Jo Example", contact: "jo@northfield-ventures.test", fields: 0 });
    expect(r.batch.rows[10]).toEqual({ row: 12, kind: "company", name: "Meadow Seed Fund", contact: "meadow-seed.test", fields: 0 });
    expect(r.warning).toBeNull();

    const [a] = actions(db);
    expect(actions(db)).toHaveLength(1);
    expect(a).toMatchObject({
      action: PASTE_ACTION,
      agent: "paste",
      target: { type: "brand", id: TENANT_ID },
      targetKey: `brand:${TENANT_ID}`,
      personId: null,
      productUserId: null,
      state: "proposed",
      review: { kind: "paste_batch", href: `/admin/crm?paste=${r.batch.id}` },
      requestedBy: { type: "member", id: "usr_1" },
      expiresAt: new Date(T0 + 7 * DAY).toISOString(),
      clearDetailsOnClose: true,
      signals: [],
      draft: null,
      fieldIds: [],
    });
    expect(a!.basis).toEqual({
      from: "box",
      read: 14,
      left: { no_contact: 1, bad_email: 0, bad_phone: 0, not_a_firm_site: 0, repeated: 0 },
      already: { people: 0, companies: 0 },
      notes: [],
    });
    // The row left out is nowhere in the store, and neither is any cell of a column not read.
    const stored = JSON.stringify(db.dump("agent_actions"));
    expect(stored).not.toContain("Una");
    expect(stored).not.toContain("Nameonly");
    // A person row keeps nothing about their firm from the sheet (its web address, its name).
    expect(stored).not.toContain("Northfield Ventures");
    expect(stored).not.toContain("advisers'\n");
    expect(db.dump("contacts")).toHaveLength(0);
    expect(db.dump("companies")).toHaveLength(0);
  });

  it("is proposed as Vizzy's when it came from the chat", async () => {
    const db = await world();
    const r = await readPaste(ctx, { text: DONE_WHEN_TSV, source: "A list a friend sent", from: "chat" }, { db, nowMs: T0 });
    expect(r.ok && r.outcome).toBe("ready");
    expect(actions(db)[0]).toMatchObject({ agent: "vizzy", basis: { from: "chat" } });
  });

  it("counts rows already in People (by email and by phone) and Companies, and keeps them out of the card", async () => {
    const db = await world();
    const person = (body: Record<string, unknown>) => {
      const p = parseNewPerson(body);
      if (!p.ok) throw new Error(p.error);
      return p.value;
    };
    await addPerson(ctx, person({ email: "jo@northfield-ventures.test" }), { db, nowIso: new Date(T0).toISOString() });
    await addPerson(ctx, person({ phone: "+44 7700 900123" }), { db, nowIso: new Date(T0).toISOString() });
    db.seed("companies", deterministicCompanyId(TENANT_ID, "meadow-seed.test"), { tenantId: TENANT_ID, domain: "meadow-seed.test", name: "Meadow", enrichmentStatus: "manual", contactCount: 0, searchTokens: [] });
    const text = [
      "First Name\tEmail\tPhone\tWebsite",
      "Jo\tJO@northfield-ventures.test\t\t",
      "Kim\tkim@example.com\t\t",
      "Vic\t\t +44 7700 900123 \t",
      "\t\t\thttps://www.meadow-seed.test",
      "\t\t\toak-lane-lenders.test",
    ].join("\n");
    const r = await readPaste(ctx, { text, source: "An event", from: "box" }, { db, nowMs: T0 + 1000 });
    if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
    expect(r.batch.counts).toEqual({ read: 5, people: 1, companies: 1, left: 0, already: 3 });
    expect(r.skipped).toEqual([
      { row: 2, reason: "in_people" },
      { row: 4, reason: "in_people" },
      { row: 5, reason: "in_companies" },
    ]);
    const a = actions(db).find((x) => x.action === PASTE_ACTION)!;
    expect(a.basis).toMatchObject({ already: { people: 2, companies: 1 } });
    const stored = JSON.stringify(a.proposal);
    expect(stored).not.toContain("jo@northfield-ventures.test");
    expect(stored).not.toContain("meadow-seed.test");
    expect(stored).not.toContain("+44 7700 900123");
  });

  it("saves field values column by column, aligned with the rows, with fieldIds equal to their keys", async () => {
    const db = await world();
    await addField(ctx, db, "company", F.stage, "Stage", "multi_select", ["Seed", "Series A"]);
    await addField(ctx, db, "company", F.hq, "Fund HQ", "text");
    await addField(ctx, db, "person", F.title, "Title", "text");
    const r = await readPaste(ctx, { text: KIT_TSV, source: "The kit, filtered", from: "box" }, { db, nowMs: T0, fields: true });
    if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
    expect(r.batch.counts).toEqual({ read: 6, people: 0, companies: 3, left: 3, already: 0 });
    expect(r.batch.notes.sort()).toEqual(["firms_left_out", "profile_links", "values_left_out"]);
    expect(r.batch.columns.read).toEqual(expect.arrayContaining([{ header: "Stages", as: "Stage" }, { header: "Title", as: "Title" }]));
    expect(r.batch.columns.left).toEqual(expect.arrayContaining(["Person Linkedin Url", "Investor City"]));
    const a = actions(db)[0]!;
    expect(a.proposal?.fields).toEqual({
      [F.stage]: [[optionId(F.stage, 0), optionId(F.stage, 1)], null, [optionId(F.stage, 1)]],
      [F.hq]: ["Leeds", "Bristol", "Cardiff"],
    });
    expect(a.fieldIds.sort()).toEqual(Object.keys(a.proposal!.fields as object).sort());
    // Firm rows: their name and domain only. No partner's name, title, city or profile link anywhere.
    expect(a.proposal?.rows).toEqual([
      { row: 2, kind: "company", domain: "northfield-ventures.test", name: "Northfield Ventures" },
      { row: 4, kind: "company", domain: "harbour-lane.test", name: "Harbour Lane Capital" },
      { row: 5, kind: "company", domain: "quayside-fund.test", name: "Quayside Fund" },
    ]);
    const stored = JSON.stringify(db.dump("agent_actions"));
    for (const gone of ["Ada", "Ben", "Cara", "Dev", "Partner", "Principal", "Associate", "linkedin", "York", "Wales"]) expect(stored, gone).not.toContain(gone);
  });

  it("refuses a card over 64 KB before saving anything", async () => {
    const db = await world();
    await addField(ctx, db, "person", F.notes, "Notes", "text");
    await addField(ctx, db, "person", F.notes2, "More notes", "text");
    await addField(ctx, db, "person", F.notes3, "Even more notes", "text");
    const long = "n".repeat(500);
    const text = ["Email\tNotes\tMore notes\tEven more notes", ...Array.from({ length: 50 }, (_, i) => `p${i}@example.com\t${long}\t${long}\t${long}`)].join("\n");
    expect(await readPaste(ctx, { text, source: "Notes", from: "box" }, { db, nowMs: T0, fields: true })).toEqual({ ok: false, error: "too_large" });
    expect(actions(db)).toHaveLength(0);
  });

  it("saves nothing when there is nothing to add", async () => {
    const db = await world();
    const r = await readPaste(ctx, { text: "Name,Email\nUna Nameonly,\nJo,jo at example", source: "A sheet", from: "box" }, { db, nowMs: T0 });
    expect(r).toEqual({
      ok: true,
      outcome: "nothing_to_add",
      skipped: [
        { row: 2, reason: "no_contact" },
        { row: 3, reason: "bad_email" },
      ],
      counts: { read: 2, people: 0, companies: 0, left: 2, already: 0 },
    });
    expect(actions(db)).toHaveLength(0);
  });

  it("needs a source and a header, and says why the text can't be read", async () => {
    const db = await world();
    expect(await readPaste(ctx, { text: DONE_WHEN_TSV, source: " \n ", from: "box" }, { db })).toEqual({ ok: false, error: "source_needed" });
    expect(await readPaste(ctx, { text: DONE_WHEN_TSV, source: "x".repeat(81), from: "box" }, { db })).toEqual({ ok: false, error: "source_needed" });
    expect(await readPaste(ctx, { text: "jo@example.com,Jo\nkim@example.com,Kim", source: "A sheet", from: "box" }, { db })).toEqual({ ok: false, error: "no_header" });
    expect(await readPaste(ctx, { text: "Email", source: "A sheet", from: "box" }, { db })).toEqual({ ok: false, error: "empty" });
    expect(cleanSource("  An\n event  ")).toBe("An event");
    expect(actions(db)).toHaveLength(0);
  });
});

describe("readPasteBatch and dismissPasteBatch", () => {
  it("reads a waiting list for this brand only, and dismisses it with its rows cleared", async () => {
    const db = await world();
    const r = await readPaste(ctx, { text: DONE_WHEN_TSV, source: "An event", from: "box" }, { db, nowMs: T0 });
    if (!r.ok || r.outcome !== "ready") throw new Error("not ready");
    const id = r.batch.id;
    expect((await readPasteBatch(ctx, id, { db, nowMs: T0 + 1000 }))?.batch).toEqual(r.batch);
    // Another brand's context reads it as not found.
    expect(await readPasteBatch(other, id, { db, nowMs: T0 + 1000 })).toBeNull();
    expect(await readPasteBatch(ctx, "aa_nope", { db })).toBeNull();
    // Past its 7 days: gone.
    expect(await readPasteBatch(ctx, id, { db, nowMs: T0 + 7 * DAY })).toBeNull();

    expect(await dismissPasteBatch(other, id, r.batch.rev, { db, nowMs: T0 + 2000 })).toBe("paste_gone");
    expect(await dismissPasteBatch(ctx, id, r.batch.rev + 1, { db, nowMs: T0 + 2000 })).toBe("changed");
    expect(await dismissPasteBatch(ctx, id, r.batch.rev, { db, nowMs: T0 + 2000 })).toBe("dismissed");
    expect(actions(db)[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null, basis: null, decidedBy: { type: "member", id: "usr_1" } });
    expect(await readPasteBatch(ctx, id, { db, nowMs: T0 + 3000 })).toBeNull();
    expect(await dismissPasteBatch(ctx, id, r.batch.rev, { db, nowMs: T0 + 3000 })).toBe("paste_gone");
  });
});
