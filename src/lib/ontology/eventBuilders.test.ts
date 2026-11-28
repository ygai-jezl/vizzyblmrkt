import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicAgentActionId, deterministicContactId } from "@/lib/crm/identifiers";
import { EventWriteSchema } from "@/lib/types/ontologyEvent";
import { consentRecordedEvent, fieldChangedEvent, recordCreatedEvent } from "./eventBuilders";
import { systemFieldId } from "./events";
import type { ContactPersonId } from "./person";

const PERSON = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const MEMBER = { type: "member" as const, id: "uid_1" };

describe("fieldChangedEvent", () => {
  it("gives a valid field change with its field id on top and a unique key", () => {
    const e = fieldChangedEvent({
      subject: { type: "person", id: PERSON },
      personId: PERSON,
      fieldId: "plan",
      object: "person",
      before: "free",
      after: "pro",
      source: "editor",
      actor: MEMBER,
      at: "2026-11-20T10:00:00.000Z",
      nonce: () => "n1",
    });
    expect(EventWriteSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      key: `field|person:${PERSON}|plan|n1`,
      kind: "record.field_changed",
      fieldId: "plan",
      personId: PERSON,
      productUserId: null,
      source: { system: "app" },
      properties: { fieldId: "plan", object: "person", before: "free", after: "pro", source: "editor" },
    });
  });

  it("makes a new key each time unless the nonce is given", () => {
    const args = {
      subject: { type: "company" as const, id: "co_1" },
      personId: null,
      fieldId: "size",
      object: "company" as const,
      before: null,
      after: 40,
      source: "agent" as const,
      actor: { type: "agent" as const, id: "vizzy" },
      at: "2026-11-20T10:00:00.000Z",
    };
    const a = fieldChangedEvent(args);
    const b = fieldChangedEvent(args);
    expect(a.key).not.toBe(b.key);
    expect(a.personId).toBeNull();
    expect(a.source).toEqual({ system: "agent" });
    expect(fieldChangedEvent({ ...args, nonce: () => "x" }).key).toBe(fieldChangedEvent({ ...args, nonce: () => "x" }).key);
  });

  it("takes a system field id and a deterministic key for a move", () => {
    const fieldId = systemFieldId("stage", "pcn_1");
    const e = fieldChangedEvent({
      subject: { type: "person", id: PERSON },
      personId: PERSON,
      productUserId: "pu_1",
      fieldId,
      object: "person",
      before: "trial",
      after: "active",
      source: "sync",
      actor: { type: "system", id: null },
      at: "2026-11-20T10:00:00.000Z",
      key: `move|${PERSON}|2026-11-20T10:00:00.000Z|stage`,
    });
    expect(e.fieldId).toBe("sys.stage.pcn_1");
    expect(e.productUserId).toBe("pu_1");
  });

  it("normalises the time and refuses a bad input when built", () => {
    const base = { subject: { type: "idea" as const, id: "spring-launch" }, personId: null, fieldId: systemFieldId("idea", "status"), object: "idea" as const, before: "draft", after: "live", source: "editor" as const, actor: MEMBER };
    expect(fieldChangedEvent({ ...base, at: "2026-11-20T10:00:00Z" }).at).toBe("2026-11-20T10:00:00.000Z");
    expect(() => fieldChangedEvent({ ...base, at: "not a time" })).toThrow(/bad_event_at/);
    expect(() => fieldChangedEvent({ ...base, at: "2026-11-20T10:00:00Z", fieldId: "a.b" })).toThrow(/bad_event/);
    expect(() => fieldChangedEvent({ ...base, at: "2026-11-20T10:00:00Z", key: "field|ada@example.com" })).toThrow(/bad_event/);
  });
});

describe("recordCreatedEvent", () => {
  it("keys the row by its subject and time", () => {
    const e = recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "form", actor: MEMBER, at: "2026-11-20T10:00:00.000Z" });
    expect(EventWriteSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ key: `created|person:${PERSON}|2026-11-20T10:00:00.000Z`, kind: "record.created", properties: { object: "person", via: "form" }, source: { system: "app" } });
  });

  it("names the agent action that filled it", () => {
    const aa = deterministicAgentActionId("ten_demo", "new_person.fill|req_1");
    const e = recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "vizzy", actor: MEMBER, at: "2026-11-20T10:00:00.000Z", agentActionId: aa });
    expect(e.agentActionId).toBe(aa);
    expect(e.source).toEqual({ system: "agent" });
    expect(() => recordCreatedEvent({ subject: { type: "agent_action", id: aa }, personId: null, via: "vizzy", actor: MEMBER, at: "2026-11-20T10:00:00.000Z" })).toThrow();
  });

  it("writes where a pasted list came from only when it is set", () => {
    const aa = deterministicAgentActionId("ten_demo", "paste.add_rows|abc");
    const pasted = recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "paste", source: "A friend's sheet", actor: MEMBER, at: "2026-11-20T10:00:00.000Z", agentActionId: aa });
    expect(EventWriteSchema.safeParse(pasted).success).toBe(true);
    expect(pasted.properties).toEqual({ object: "person", via: "paste", source: "A friend's sheet" });
    const typed = recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "form", source: null, actor: MEMBER, at: "2026-11-20T10:00:00.000Z" });
    expect(typed.properties).toEqual({ object: "person", via: "form" });
    expect(() => recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "paste", source: "x".repeat(81), actor: MEMBER, at: "2026-11-20T10:00:00.000Z" })).toThrow();
  });
});

describe("consentRecordedEvent", () => {
  it("records granted consent on the person, keyed by person, purpose and time", () => {
    const e = consentRecordedEvent({ personId: PERSON, purpose: "marketing_email", how: "verbal", note: null, recordedBy: "uid_1", agreedAt: null, at: "2026-11-20T10:00:00.000Z", actor: MEMBER });
    expect(EventWriteSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      key: `consent|${PERSON}|marketing_email|2026-11-20T10:00:00.000Z`,
      subject: { type: "person", id: PERSON },
      properties: { purpose: "marketing_email", state: "granted", how: "verbal", recordedBy: "uid_1" },
    });
    expect(() => consentRecordedEvent({ personId: PERSON, purpose: "marketing_email", how: "verbal", note: null, recordedBy: "lee@example.com", agreedAt: null, at: "2026-11-20T10:00:00.000Z", actor: MEMBER })).toThrow();
  });
});

describe("the builders", () => {
  it("never put an address in a key: person keys carry the ct_ id", () => {
    const keys = [
      fieldChangedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, fieldId: "plan", object: "person", before: null, after: "ada@example.com", source: "editor", actor: MEMBER, at: "2026-11-20T10:00:00.000Z" }).key,
      recordCreatedEvent({ subject: { type: "person", id: PERSON }, personId: PERSON, via: "form", actor: MEMBER, at: "2026-11-20T10:00:00.000Z" }).key,
      consentRecordedEvent({ personId: PERSON, purpose: "product_email", how: "verbal", note: null, recordedBy: "uid_1", agreedAt: null, at: "2026-11-20T10:00:00.000Z", actor: MEMBER }).key,
    ];
    for (const k of keys) expect(k, k).not.toContain("@");
  });

  it("import no node: module", () => {
    const text = readFileSync(join(process.cwd(), "src/lib/ontology/eventBuilders.ts"), "utf8");
    expect(/from\s+["']node:/.test(text)).toBe(false);
  });
});
