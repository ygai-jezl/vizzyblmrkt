import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicAgentActionId, deterministicContactId, deterministicEventId } from "@/lib/crm/identifiers";
import type { ContactPersonId } from "@/lib/ontology/person";
import { EVENT_LIMITS, EventWriteSchema, StoredEventSchema, type EventWrite } from "./ontologyEvent";

const PERSON = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const ACTION = deterministicAgentActionId("ten_demo", "person_fields.suggest|x");

function fieldChange(over: Partial<EventWrite> = {}): EventWrite {
  return {
    key: "field|person:ct_x|plan|n1",
    kind: "record.field_changed",
    at: "2026-11-20T10:00:00.000Z",
    subject: { type: "person", id: PERSON },
    personId: PERSON,
    fieldId: "plan",
    source: { system: "app" },
    actor: { type: "member", id: "uid_1" },
    properties: { fieldId: "plan", object: "person", before: "free", after: "pro", source: "editor" },
    ...over,
  };
}

function agentRow(over: Partial<EventWrite> = {}): EventWrite {
  return {
    key: `agent|${ACTION}|1`,
    kind: "agent.proposed",
    at: "2026-11-20T10:00:00.000Z",
    subject: { type: "agent_action", id: ACTION },
    personId: PERSON,
    agentActionId: ACTION,
    source: { system: "agent" },
    actor: { type: "agent", id: "vizzy" },
    properties: { agentActionId: ACTION, agent: "vizzy", action: "person_fields.suggest", target: { type: "person", id: PERSON }, state: "proposed" },
    ...over,
  };
}

const ok = (w: unknown) => EventWriteSchema.safeParse(w).success;

describe("EventWriteSchema", () => {
  it("accepts a field change and an agent step", () => {
    expect(ok(fieldChange())).toBe(true);
    expect(ok(agentRow())).toBe(true);
    expect(ok(fieldChange({ fieldId: "sys.stage.pcn_1", properties: { fieldId: "sys.stage.pcn_1", object: "person", before: null, after: "active", source: "sync" } }))).toBe(true);
  });

  it("refuses a key with an address, a space or over 300 characters", () => {
    expect(ok(fieldChange({ key: "consent|ada@example.com" }))).toBe(false);
    expect(ok(fieldChange({ key: "move|Ada Lovelace" }))).toBe(false);
    expect(ok(fieldChange({ key: "k".repeat(EVENT_LIMITS.keyChars + 1) }))).toBe(false);
    expect(ok(fieldChange({ key: "k".repeat(EVENT_LIMITS.keyChars) }))).toBe(true);
  });

  it("refuses a time that is not canonical", () => {
    expect(ok(fieldChange({ at: "2026-11-20T10:00:00Z" }))).toBe(false);
    expect(ok(fieldChange({ at: "20 November 2026" }))).toBe(false);
  });

  it("refuses a person subject whose id is not the personId", () => {
    const other = deterministicContactId("ten_demo", "bo@example.com") as ContactPersonId;
    expect(ok(fieldChange({ personId: other }))).toBe(false);
    expect(ok(fieldChange({ personId: null }))).toBe(false);
  });

  it("refuses a field change without its field id, or with another one in its properties", () => {
    expect(ok(fieldChange({ fieldId: null }))).toBe(false);
    expect(ok(fieldChange({ fieldId: "tier" }))).toBe(false);
    expect(ok(fieldChange({ fieldId: "a.b", properties: { fieldId: "a.b", object: "person", before: 1, after: 2, source: "editor" } }))).toBe(false);
    expect(ok(agentRow({ fieldId: "plan" }))).toBe(false);
  });

  it("refuses an agent step without its action, or about something else", () => {
    expect(ok(agentRow({ agentActionId: null }))).toBe(false);
    expect(ok(agentRow({ subject: { type: "person", id: PERSON } }))).toBe(false);
    expect(ok(agentRow({ subject: { type: "agent_action", id: deterministicAgentActionId("ten_demo", "other") } }))).toBe(false);
  });

  it("measures properties in UTF-8 bytes, not characters", () => {
    // "€" is 3 bytes: about 11,000 of them is under 32,768 characters but over 32 KB.
    const near = "€".repeat(Math.floor(EVENT_LIMITS.propertiesBytes / 3) - 40);
    expect(ok(fieldChange({ properties: { fieldId: "plan", object: "person", before: null, after: near, source: "editor" } }))).toBe(true);
    const over = "€".repeat(Math.floor(EVENT_LIMITS.propertiesBytes / 3) + 10);
    expect(over.length).toBeLessThan(EVENT_LIMITS.propertiesBytes);
    expect(ok(fieldChange({ properties: { fieldId: "plan", object: "person", before: null, after: over, source: "editor" } }))).toBe(false);
  });

  it("keeps addresses out of the actor, refs and identity", () => {
    expect(ok(fieldChange({ actor: { type: "member", id: "lee@example.com" } }))).toBe(false);
    expect(ok(fieldChange({ refs: { sendId: "ada@example.com" } }))).toBe(false);
    expect(ok(fieldChange({ identity: { signupId: "ada@example.com" } }))).toBe(false);
    expect(ok(fieldChange({ refs: { sendId: "snd_1" }, identity: { signupId: "s_1" } }))).toBe(true);
  });

  it("checks consent and created rows' properties", () => {
    const consent: EventWrite = {
      key: `consent|${PERSON}|marketing_email|2026-11-20T10:00:00.000Z`,
      kind: "consent.recorded",
      at: "2026-11-20T10:00:00.000Z",
      subject: { type: "person", id: PERSON },
      personId: PERSON,
      source: { system: "app" },
      actor: { type: "member", id: "uid_1" },
      properties: { purpose: "marketing_email", state: "granted", how: "verbal", note: null, recordedBy: "uid_1", agreedAt: null },
    };
    expect(ok(consent)).toBe(true);
    expect(ok({ ...consent, properties: { ...consent.properties, recordedBy: "lee@example.com" } })).toBe(false);
    expect(ok({ ...consent, subject: { type: "company", id: "co_1" }, personId: null })).toBe(false);
    const created: EventWrite = { ...consent, key: "created|company:co_1|t", kind: "record.created", subject: { type: "company", id: "co_1" }, personId: null, properties: { object: "company", via: "form" } };
    expect(ok(created)).toBe(true);
    expect(ok({ ...created, properties: { object: "company" } })).toBe(false);
  });
});

describe("StoredEventSchema", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    ...fieldChange(),
    id: deterministicEventId("ten_demo", "field|person:ct_x|plan|n1"),
    tenantId: "ten_demo",
    subjectKey: `person:${PERSON}`,
    productUserId: null,
    agentActionId: null,
    identity: null,
    ideaCredited: null,
    refs: null,
    createdAt: "2026-11-20T10:00:01.000Z",
    blankedAt: null,
    blankedReason: null,
    ...over,
  });

  it("reads a stored row, a blanked one, and refuses a wrong subject key or a missing null", () => {
    expect(StoredEventSchema.safeParse(stored()).success).toBe(true);
    const blanked = stored({ blankedAt: "2026-11-21T10:00:00.000Z", blankedReason: "field_erased", properties: { fieldId: "plan", object: "person", before: null, after: null, source: "editor" } });
    expect(StoredEventSchema.safeParse(blanked).success).toBe(true);
    expect(StoredEventSchema.safeParse(stored({ subjectKey: "person:ct_other" })).success).toBe(false);
    expect(StoredEventSchema.safeParse(stored({ blankedAt: "2026-11-21T10:00:00.000Z" })).success).toBe(false);
    const { blankedAt: _b, ...missing } = stored();
    expect(StoredEventSchema.safeParse(missing).success).toBe(false);
  });
});

describe("the shared types", () => {
  it("import no node: module and use no Buffer, so the browser can load them", () => {
    for (const file of ["src/lib/types/ontologyEvent.ts", "src/lib/types/agentAction.ts", "src/lib/ontology/events.ts", "src/lib/ontology/consent.ts"]) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      expect(/from\s+["']node:|require\(\s*["']node:|import\(\s*["']node:/.test(text), file).toBe(false);
      expect(/\bBuffer\b/.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")), file).toBe(false);
    }
  });
});
