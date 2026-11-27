import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { deterministicCompanyId } from "@/lib/crm/identifiers";
import { ctx, seedWorld, T0, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import type { AgentAction } from "@/lib/types/agentAction";
import type { Company } from "@/lib/types/company";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import { addPasteBatch } from "./apply";
import { readPaste } from "./batch";
import { firestoreSafe } from "./testing/firestoreShape";
import { DONE_WHEN_TSV } from "./testing/samples";
import { addField, F } from "./testing/world";

/**
 * What an add does when a write fails part way: the close tried again, a press again that closes
 * it with nobody added twice, a dismiss that lands while the adds run, and a company a stopped add
 * left without its record.created row.
 */

const trouble = vi.hoisted(() => ({ actedFails: 0, dismissFirst: false, companyRowFailsFor: null as string | null }));

vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...real,
    transitionAgentAction: vi.fn(async (...args: Parameters<typeof real.transitionAgentAction>) => {
      const [c, id, t, opts] = args;
      if (t.to === "acted" && trouble.dismissFirst) {
        trouble.dismissFirst = false;
        await real.transitionAgentAction(c, id, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_2" }, at: t.at, expectRev: t.expectRev, clearDetails: true }, opts);
      }
      if (t.to === "acted" && trouble.actedFails > 0) {
        trouble.actedFails -= 1;
        throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
      }
      return real.transitionAgentAction(...args);
    }),
    appendEvents: vi.fn(async (...args: Parameters<typeof real.appendEvents>) => {
      if (trouble.companyRowFailsFor && args[1].some((e) => e.subject.id === trouble.companyRowFailsFor)) throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
      return real.appendEvents(...args);
    }),
  };
});

const company = (db: FakeFirestore, domain: string) => db.raw("companies", deterministicCompanyId(TENANT_ID, domain)) as unknown as Company | undefined;
const created = (db: FakeFirestore) => (db.dump("ontology_events") as unknown as StoredEvent[]).filter((e) => e.kind === "record.created");
const action = (db: FakeFirestore, id: string) => db.raw("agent_actions", id) as unknown as AgentAction;

function seeded(): FakeFirestore {
  const db = new FakeFirestore();
  seedWorld(db);
  return db;
}

async function pasted(db = seeded(), text = DONE_WHEN_TSV, fields = false) {
  const r = await readPaste(ctx, { text, source: "Our advisers' sheet", from: "box" }, { db, nowMs: T0, fields });
  if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
  return { db, id: r.batch.id, rev: r.batch.rev };
}

beforeEach(() => {
  trouble.actedFails = 0;
  trouble.dismissFirst = false;
  trouble.companyRowFailsFor = null;
});

describe("addPasteBatch when a write fails", () => {
  it("tries the close once more, and closes the card with its rows cleared", async () => {
    const { db, id, rev } = await pasted();
    trouble.actedFails = 1;
    expect(await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 })).toMatchObject({ ok: true, added: { people: 10, companies: 3 } });
    expect(action(db, id)).toMatchObject({ state: "acted", proposal: null, basis: null });
  });

  it("throws when the close fails twice, leaving the card open, and a press again closes it with nobody added twice", async () => {
    const { db, id, rev } = await pasted();
    trouble.actedFails = 2;
    await expect(addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 })).rejects.toThrow("UNAVAILABLE");
    expect(action(db, id)).toMatchObject({ state: "proposed", rev });
    expect(action(db, id).proposal).not.toBeNull();
    expect(db.dump("contacts")).toHaveLength(10);

    const again = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 120_000 });
    expect(again).toEqual({ ok: true, added: { people: 0, companies: 0 }, already: { people: 10, companies: 3 }, fieldsNotSaved: 0 });
    expect(action(db, id)).toMatchObject({ state: "acted", proposal: null, basis: null });
    expect(db.dump("contacts")).toHaveLength(10);
    expect(db.dump("companies")).toHaveLength(3);
    expect(created(db)).toHaveLength(13);
  });

  it("answers its counts when the card was dismissed while the adds ran, and the rows stay cleared", async () => {
    const { db, id, rev } = await pasted();
    trouble.dismissFirst = true;
    expect(await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 })).toMatchObject({ ok: true, added: { people: 10, companies: 3 } });
    expect(action(db, id)).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null, basis: null });
  });

  it("finishes a company a stopped add left without its row, at the company's own time, and keeps its fields", async () => {
    const db = seeded();
    await addField(ctx, db, "company", F.hq, "Fund HQ", "text");
    const text = ["Website\tCompany\tFund HQ", "meadow-seed.test\tMeadow Seed Fund\tLeeds", "oak-lane-lenders.test\tOak Lane Lenders\tYork"].join("\n");
    const { id, rev } = await pasted(db, text, true);
    const meadow = deterministicCompanyId(TENANT_ID, "meadow-seed.test");
    trouble.companyRowFailsFor = meadow;
    trouble.actedFails = 2;
    await expect(addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000, fields: true })).rejects.toThrow("UNAVAILABLE");
    expect(company(db, "meadow-seed.test")).toMatchObject({ fields: { [F.hq]: "Leeds" } });
    expect(created(db).filter((e) => e.subject.id === meadow)).toHaveLength(0);
    const changesBefore = (db.dump("ontology_events") as unknown as StoredEvent[]).filter((e) => e.kind === "record.field_changed").length;

    trouble.companyRowFailsFor = null;
    const again = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 120_000, fields: true });
    expect(again).toEqual({ ok: true, added: { people: 0, companies: 1 }, already: { people: 0, companies: 1 }, fieldsNotSaved: 0 });
    const row = created(db).filter((e) => e.subject.id === meadow);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ at: company(db, "meadow-seed.test")!.createdAt, agentActionId: id, properties: { via: "paste", source: "Our advisers' sheet" } });
    // Its fields were already set by the first press, so they are left as they are.
    expect((db.dump("ontology_events") as unknown as StoredEvent[]).filter((e) => e.kind === "record.field_changed")).toHaveLength(changesBefore);
    expect(action(db, id)).toMatchObject({ state: "acted", proposal: null });
    expect(firestoreSafe([...db.dump("companies"), ...db.dump("agent_actions"), ...db.dump("ontology_events")])).toBeNull();
  });

  it("counts a pasted company from a list with another source as already here, and writes it no row", async () => {
    const db = seeded();
    const first = await pasted(db, "Website\nmeadow-seed.test");
    const second = await readPaste(ctx, { text: "Website\nmeadow-seed.test", source: "Another sheet", from: "box" }, { db, nowMs: T0 });
    if (!second.ok || second.outcome !== "ready") throw new Error("not ready");
    await addPasteBatch(ctx, first.id, first.rev, { db, nowMs: T0 + 60_000 });
    const r = await addPasteBatch(ctx, second.batch.id, second.batch.rev, { db, nowMs: T0 + 120_000 });
    expect(r).toMatchObject({ ok: true, added: { companies: 0 }, already: { companies: 1 } });
    expect(created(db)).toHaveLength(1);
  });
});
