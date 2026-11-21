import { describe, expect, it } from "vitest";
import { appendEvents, proposeAgentAction } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { agentDedupeKey } from "@/lib/types/agentAction";
import { fieldChangedEvent, recordCreatedEvent } from "./eventBuilders";
import type { ContactPersonId } from "./person";
import { decodeTimelineCursor, encodeTimelineCursor, InvalidCursorError, listPersonEvents, listSubjectEvents } from "./timeline";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const ADA = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const BO = deterministicContactId("ten_demo", "bo@example.com") as ContactPersonId;
const MEMBER = { type: "member" as const, id: "uid_1" };

let n = 0;
const change = (person: ContactPersonId, at: string, fieldId = "plan") =>
  fieldChangedEvent({ subject: { type: "person", id: person }, personId: person, fieldId, object: "person", before: null, after: `v${(n += 1)}`, source: "editor", actor: MEMBER, at, nonce: () => `n${n}` });

/** Ada has five rows: two at 10:00 (a tie), and one each at 09:00, 11:00 and 12:00. */
async function world() {
  const db = new FakeFirestore();
  const ada = [
    change(ADA, "2026-11-20T09:00:00.000Z"),
    change(ADA, "2026-11-20T10:00:00.000Z"),
    change(ADA, "2026-11-20T10:00:00.000Z", "tier"),
    change(ADA, "2026-11-20T11:00:00.000Z"),
    recordCreatedEvent({ subject: { type: "person", id: ADA }, personId: ADA, via: "form", actor: MEMBER, at: "2026-11-20T12:00:00.000Z" }),
  ];
  await appendEvents(ctx, [...ada, change(BO, "2026-11-20T10:30:00.000Z")], { db });
  await appendEvents(other, [change(deterministicContactId("ten_other", "ada@example.com") as ContactPersonId, "2026-11-20T10:00:00.000Z")], { db });
  // A row about Ada written straight into the store under the other brand: never hers.
  db.seed("ontology_events", "ev_theirs", { tenantId: "ten_other", personId: ADA, at: "2026-11-20T13:00:00.000Z" });
  return { db, ada };
}

describe("listPersonEvents", () => {
  it("gives one person's rows newest first, ties in id order descending, and nobody else's", async () => {
    const { db } = await world();
    const { events, next } = await listPersonEvents(ctx, ADA, { db });
    expect(next).toBeNull();
    expect(events.map((e) => e.at)).toEqual([
      "2026-11-20T12:00:00.000Z",
      "2026-11-20T11:00:00.000Z",
      "2026-11-20T10:00:00.000Z",
      "2026-11-20T10:00:00.000Z",
      "2026-11-20T09:00:00.000Z",
    ]);
    const tie = events.filter((e) => e.at === "2026-11-20T10:00:00.000Z").map((e) => e.id);
    expect(tie).toEqual([...tie].sort().reverse());
    expect(events.every((e) => e.personId === ADA && e.tenantId === "ten_demo")).toBe(true);
  });

  it("pages with limit 2 across the tie, every row once and no gap", async () => {
    const { db } = await world();
    const all = (await listPersonEvents(ctx, ADA, { db })).events.map((e) => e.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: Awaited<ReturnType<typeof listPersonEvents>> = await listPersonEvents(ctx, ADA, { db, limit: 2, cursor });
      seen.push(...page.events.map((e) => e.id));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(seen).toEqual(all);
  });

  it("filters kinds after the read, and the cursor still advances past a short page", async () => {
    const { db } = await world();
    const first = await listPersonEvents(ctx, ADA, { db, limit: 2, kinds: ["record.created"] });
    expect(first.events.map((e) => e.kind)).toEqual(["record.created"]);
    expect(first.next).not.toBeNull();
    const second = await listPersonEvents(ctx, ADA, { db, limit: 2, kinds: ["record.created"], cursor: first.next });
    expect(second.events).toEqual([]);
    expect(second.next).not.toBeNull();
  });

  it("includes the agent steps of actions about them", async () => {
    const { db } = await world();
    await proposeAgentAction(
      ctx,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", "x1"),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: ADA },
        personId: ADA,
        proposal: null,
        basis: null,
        signals: [],
        review: null,
        requestedBy: MEMBER,
        expiresAt: "2026-12-20T10:00:00.000Z",
        at: "2026-11-20T14:00:00.000Z",
      },
      { db },
    );
    const { events } = await listPersonEvents(ctx, ADA, { db, kinds: ["agent.proposed"] });
    expect(events.map((e) => e.kind)).toEqual(["agent.proposed"]);
  });

  it("refuses a cursor it didn't make, and caps the page at 100", async () => {
    const { db } = await world();
    for (const bad of ["nope", "!!", encodeTimelineCursor({ at: "2026-11-20T10:00:00Z", id: "ev_x" }), Buffer.from("[1,2]").toString("base64url")]) {
      await expect(listPersonEvents(ctx, ADA, { db, cursor: bad }), bad).rejects.toThrow(InvalidCursorError);
    }
    const many = Array.from({ length: 150 }, (_, i) => change(BO, new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 60_000).toISOString()));
    await appendEvents(ctx, many, { db });
    const page = await listPersonEvents(ctx, BO, { db, limit: 500 });
    expect(page.events).toHaveLength(100);
    expect(page.next).not.toBeNull();
  });

  it("round trips a cursor", () => {
    const c = { at: "2026-11-20T10:00:00.000Z", id: `ev_${"a".repeat(40)}` };
    expect(decodeTimelineCursor(encodeTimelineCursor(c))).toEqual(c);
  });
});

describe("listSubjectEvents", () => {
  it("gives only that subject's rows", async () => {
    const { db } = await world();
    const company = fieldChangedEvent({ subject: { type: "company", id: "co_1" }, personId: null, fieldId: "size", object: "company", before: 1, after: 2, source: "editor", actor: MEMBER, at: "2026-11-20T10:00:00.000Z", nonce: () => "c1" });
    const idea = fieldChangedEvent({ subject: { type: "idea", id: "spring-launch" }, personId: null, fieldId: "sys.idea.status", object: "idea", before: "draft", after: "live", source: "editor", actor: MEMBER, at: "2026-11-20T10:00:00.000Z", nonce: () => "i1" });
    await appendEvents(ctx, [company, idea], { db });
    expect((await listSubjectEvents(ctx, { type: "company", id: "co_1" }, { db })).events.map((e) => e.key)).toEqual([company.key]);
    expect((await listSubjectEvents(ctx, { type: "idea", id: "spring-launch" }, { db })).events.map((e) => e.key)).toEqual([idea.key]);
    expect((await listSubjectEvents(ctx, { type: "person", id: BO }, { db })).events).toHaveLength(1);
  });
});
