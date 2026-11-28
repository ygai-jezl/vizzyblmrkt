import { describe, expect, it } from "vitest";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { TenantContext } from "@/lib/tenant/types";
import { EmailEventType, type EmailEvent } from "@/lib/types/emailEvent";
import { ProductEventSchema, type ProductEvent } from "@/lib/types/productEvent";
import { typeById } from "./registry";
import {
  actorOf,
  AGENT_TARGET_REGISTRY_ID,
  AGENT_TARGET_TYPES,
  isCanonicalInstant,
  isStoredEventKind,
  isSystemFieldId,
  jsonBytes,
  parseSubjectKey,
  STORED_EVENT_KINDS,
  SUBJECT_TYPE_REGISTRY_ID,
  SUBJECT_TYPES,
  subjectKey,
  systemFieldId,
  USER_FIELD_ID,
  EMAIL_EVENT_KIND,
  EVENT_KINDS,
  fromEmailEvent,
  fromPersonMove,
  fromProductEvent,
  fromWorkLog,
  fromStoredEvent,
  isEventKind,
  PRODUCT_EVENT_KIND,
  type AgentActionEvent,
  type EventKind,
} from "./events";
import type { ContactPersonId } from "./person";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import { deterministicEventId } from "@/lib/crm/identifiers";
import { WORK_LOG_KINDS, WorkLogRowSchema, type WorkLogRow } from "@/lib/work/types";

const PERSON = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;

function emailRow(over: Partial<Omit<EmailEvent, "personId"> & { personId?: string | null }> = {}): Omit<EmailEvent, "personId"> & { personId?: string | null } {
  return {
    id: "evt:j1:n1:s1:control:open",
    tenantId: "ten_demo",
    campaignId: "c1",
    journeyId: "j1",
    nodeId: "n1",
    signupId: "s1",
    variantId: "control",
    type: "open",
    ts: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:01.000Z",
    ...over,
  };
}

function productRow(over: Partial<Omit<ProductEvent, "personId"> & { personId?: string | null }> = {}): Omit<ProductEvent, "personId"> & { personId?: string | null } {
  return {
    id: "pe_1",
    tenantId: "ten_demo",
    connectionId: "conn_1",
    productUserId: "pu_1",
    externalUserId: "ada@example.com",
    messageId: "m1",
    type: "track",
    event: "project_created",
    payload: { email: "ada@example.com", plan: "pro" },
    timestamp: "2026-11-01T10:00:00.000Z",
    receivedAt: "2026-11-01T10:00:02.000Z",
    applied: true,
    ...over,
  };
}

describe("event kinds", () => {
  it("are unique and shaped family.what", () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
    for (const k of EVENT_KINDS) expect(k).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("include the agent trail, record moves and person plans, and never plan.*", () => {
    for (const k of ["agent.proposed", "agent.approved", "agent.acted", "agent.undone", "record.merged", "record.repointed", "person_plan.drafted", "person_plan.approved", "social.engaged"]) {
      expect(isEventKind(k), k).toBe(true);
    }
    expect(EVENT_KINDS.some((k) => k.startsWith("plan."))).toBe(false);
    expect(isEventKind("plan.changed")).toBe(false);
  });

  it("map every email event type and every product event type", () => {
    for (const t of EmailEventType.options) expect(EVENT_KINDS, t).toContain(EMAIL_EVENT_KIND[t]);
    expect(Object.keys(EMAIL_EVENT_KIND).sort()).toEqual([...EmailEventType.options].sort());
    const productTypes = ProductEventSchema.shape.type.options;
    for (const t of productTypes) expect(EVENT_KINDS, t).toContain(PRODUCT_EVENT_KIND[t]);
    expect(Object.keys(PRODUCT_EVENT_KIND).sort()).toEqual([...productTypes].sort());
  });
});

describe("fromEmailEvent", () => {
  it("takes the person from personId, or null", () => {
    expect(fromEmailEvent(emailRow({ personId: PERSON })).person).toBe(PERSON);
    expect(fromEmailEvent(emailRow()).person).toBeNull();
    expect(fromEmailEvent(emailRow({ personId: "pu_1" })).person).toBeNull();
  });

  it("names the sign-up or the product user it came through, and the idea it is credited to", () => {
    const signup = fromEmailEvent(emailRow({ personId: PERSON }));
    expect(signup).toMatchObject({
      kind: "email.opened",
      identity: { signupId: "s1" },
      ideaCredited: "c1",
      source: { system: "mandrill" },
      actor: { type: "person", id: PERSON },
      refs: { journeyId: "j1", nodeId: "n1" },
    });
    const product = fromEmailEvent(emailRow({ type: "send", campaignId: "", recipientKind: "product_user", signupId: "pu_1", connectionId: "conn_1", enrolmentId: "en_1" }));
    expect(product).toMatchObject({
      kind: "email.sent",
      identity: { productUserId: "pu_1", connectionId: "conn_1" },
      ideaCredited: null,
      source: { system: "mandrill", connectionId: "conn_1" },
      actor: { type: "system", id: null },
      refs: { journeyId: "j1", nodeId: "n1", enrolmentId: "en_1" },
    });
  });

  it("keeps a click's link without anything that could name the person", () => {
    expect(fromEmailEvent(emailRow({ type: "click", url: "https://example.test/pricing?utm_source=x&email=a@b.co#top" })).properties).toEqual({
      variantId: "control",
      link: "https://example.test/pricing",
    });
    expect(fromEmailEvent(emailRow({ type: "click", url: "mailto:ada@example.com" })).properties).toEqual({ variantId: "control" });
    expect(fromEmailEvent(emailRow({ type: "click", url: "https://example.test/@ada" })).properties).toEqual({ variantId: "control" });
  });
});

describe("fromProductEvent", () => {
  it("takes the person from personId, and never for an erase", () => {
    expect(fromProductEvent(productRow({ personId: PERSON })).person).toBe(PERSON);
    expect(fromProductEvent(productRow()).person).toBeNull();
    const erased = fromProductEvent(productRow({ type: "erase", event: null, personId: PERSON }));
    expect(erased.kind).toBe("product.erased");
    expect(erased.person).toBeNull();
    expect(erased.identity).toEqual({ connectionId: "conn_1" });
  });

  it("keeps the event name and leaves the payload and the product's own user id out", () => {
    const e = fromProductEvent(productRow({ personId: PERSON, entityId: "ws_1" }));
    expect(e).toMatchObject({
      kind: "product.tracked",
      identity: { productUserId: "pu_1", connectionId: "conn_1" },
      source: { system: "connect", connectionId: "conn_1" },
      actor: { type: "product", id: "conn_1" },
      refs: { entityId: "ws_1" },
      properties: { event: "project_created", applied: true },
    });
  });
});

describe("no event carries an address", () => {
  it("holds for every email and product row, whatever they hold", () => {
    const rows = [
      ...EmailEventType.options.map((type) => fromEmailEvent(emailRow({ type, personId: PERSON, url: "https://example.test/a?to=ada@example.com" }))),
      fromEmailEvent(emailRow({ type: "click", url: "mailto:ada@example.com" })),
      ...(["identify", "track", "erase"] as const).map((type) => fromProductEvent(productRow({ type, personId: PERSON }))),
    ];
    for (const e of rows) expect(JSON.stringify(e), e.kind).not.toContain("@");
  });
});

describe("actorOf", () => {
  const SOURCES = ["host", "tenant_param", "idtoken", "system", "agent", "api_key"] as const satisfies readonly TenantContext["source"][];
  // Fails to compile when TenantContext gains a source this list (and actorOf) doesn't cover.
  type Missing = Exclude<TenantContext["source"], (typeof SOURCES)[number]>;
  const covered: [Missing] extends [never] ? true : false = true;

  it("covers every way a request is established", () => {
    expect(covered).toBe(true);
    const types = Object.fromEntries(SOURCES.map((source) => [source, actorOf({ source, userId: "u1" }, PERSON).type]));
    expect(types).toEqual({ host: "person", tenant_param: "person", idtoken: "member", system: "system", agent: "agent", api_key: "product" });
  });

  it("names the person on a public page, the member when signed in, and nobody for the system", () => {
    expect(actorOf({ source: "host" }, PERSON)).toEqual({ type: "person", id: PERSON });
    expect(actorOf({ source: "tenant_param" })).toEqual({ type: "person", id: null });
    expect(actorOf({ source: "idtoken", userId: "u1" })).toEqual({ type: "member", id: "u1" });
    expect(actorOf({ source: "agent", userId: "u1" })).toEqual({ type: "agent", id: "u1" });
    expect(actorOf({ source: "api_key" })).toEqual({ type: "product", id: null });
    expect(actorOf({ source: "system", userId: "u1" })).toEqual({ type: "system", id: null });
  });
});

describe("AgentActionEvent", () => {
  it("is an envelope with an agent kind and the action's detail", () => {
    const e: AgentActionEvent = {
      id: "ev_1",
      kind: "agent.proposed",
      at: "2026-11-01T10:00:00.000Z",
      person: null,
      identity: null,
      ideaCredited: null,
      source: { system: "agent" },
      actor: { type: "agent", id: "u1" },
      refs: {},
      properties: {
        agentActionId: `aa_${"0".repeat(40)}`,
        agent: "vizzy",
        action: "draft_article",
        target: { type: "idea", id: "c1" },
        state: "proposed",
        draft: { kind: "content_plan", ref: "p1" },
      },
    };
    const kind: EventKind = e.kind;
    expect(kind.startsWith("agent.")).toBe(true);
  });
});

describe("fromPersonMove", () => {
  const FROM = deterministicContactId("ten_demo", "pu:pu_1") as ContactPersonId;
  const move = (kind: "record.merged" | "record.repointed") => ({
    id: "mv_1",
    tenantId: "ten_demo",
    kind,
    fromPersonId: FROM,
    personId: PERSON,
    productUserId: "pu_1",
    connectionId: "conn_1",
    at: "2026-11-01T10:00:00.000Z",
    repoint: "pending" as const,
    createdAt: "2026-11-01T10:00:01.000Z",
  });

  it("maps both kinds, to the person they moved to, with the one they left", () => {
    for (const kind of ["record.merged", "record.repointed"] as const) {
      expect(fromPersonMove(move(kind))).toEqual({
        id: "mv_1",
        kind,
        at: "2026-11-01T10:00:00.000Z",
        person: PERSON,
        identity: { productUserId: "pu_1", connectionId: "conn_1" },
        ideaCredited: null,
        source: { system: "connect", connectionId: "conn_1" },
        actor: { type: "product", id: "conn_1" },
        refs: {},
        properties: { fromPersonId: FROM, repoint: "pending" },
      });
    }
  });

  it("names no person for an id that isn't a ct_ id", () => {
    const e = fromPersonMove({ ...move("record.merged"), personId: "pu_1", fromPersonId: "pu_2" });
    expect(e.person).toBeNull();
    expect(e.properties.fromPersonId).toBeNull();
  });
});

describe("the event history's kinds", () => {
  it("has the four new kinds, and stores only kinds the envelope has", () => {
    for (const k of ["record.created", "record.field_changed", "consent.recorded", "agent.declined"]) expect(isEventKind(k), k).toBe(true);
    for (const k of STORED_EVENT_KINDS) expect(EVENT_KINDS, k).toContain(k);
    expect(STORED_EVENT_KINDS.some((k) => k.startsWith("plan."))).toBe(false);
    expect(isStoredEventKind("email.opened")).toBe(false);
    expect(isStoredEventKind("agent.declined")).toBe(true);
  });
});

describe("subjects and targets", () => {
  it("round trip through their key, and refuse anything else", () => {
    for (const type of SUBJECT_TYPES) {
      const s = { type, id: `${type}_1` };
      expect(parseSubjectKey(subjectKey(s))).toEqual(s);
    }
    expect(subjectKey({ type: "idea", id: "spring-launch" })).toBe("idea:spring-launch");
    for (const bad of ["record:x", "person", "person:", ":x", "company:a b", "person:ada@example.com", ""]) expect(parseSubjectKey(bad), bad).toBeNull();
  });

  it("map every subject and target type to a type in the registry", () => {
    for (const t of SUBJECT_TYPES) expect(typeById(SUBJECT_TYPE_REGISTRY_ID[t]), t).toBeDefined();
    for (const t of AGENT_TARGET_TYPES) expect(typeById(AGENT_TARGET_REGISTRY_ID[t]), t).toBeDefined();
  });

  it("give a company or idea target the same key as its subject", () => {
    for (const type of ["company", "idea"] as const) {
      const target = { type, id: "x_1" };
      expect(`${target.type}:${target.id}`).toBe(subjectKey(target));
    }
  });
});

describe("field ids", () => {
  it("builds system field ids from plain parts only", () => {
    expect(systemFieldId("stage", "pcn_1")).toBe("sys.stage.pcn_1");
    expect(isSystemFieldId("sys.idea.status")).toBe(true);
    for (const parts of [["a.b"], ["a", ""], [], ["a b"], ["ada@example.com"]]) expect(() => systemFieldId(...parts), parts.join("|")).toThrow();
    expect(isSystemFieldId("sys.")).toBe(false);
    expect(isSystemFieldId("stage")).toBe(false);
  });

  it("keeps the brand's own field ids apart from system ones, with no dots", () => {
    expect(USER_FIELD_ID.test("plan_tier")).toBe(true);
    expect(USER_FIELD_ID.test("Plan-2")).toBe(true);
    for (const bad of ["sys.x", "a.b", "", "a b", "x".repeat(65)]) expect(USER_FIELD_ID.test(bad), bad).toBe(false);
  });
});

describe("times and sizes", () => {
  it("accepts only what toISOString gives", () => {
    expect(isCanonicalInstant("2026-11-20T10:00:00.000Z")).toBe(true);
    for (const bad of ["2026-11-20T10:00:00Z", "2026-11-20T10:00:00.000+00:00", "2026-02-30T10:00:00.000Z", "", 5]) expect(isCanonicalInstant(bad), String(bad)).toBe(false);
  });

  it("counts bytes in UTF-8", () => {
    expect(jsonBytes({ a: "é" })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(jsonBytes("€")).toBe(5);
  });
});

describe("fromStoredEvent", () => {
  const row = (over: Partial<StoredEvent> = {}): StoredEvent => ({
    id: deterministicEventId("ten_demo", "created|company:co_1|t"),
    tenantId: "ten_demo",
    key: "created|company:co_1|t",
    kind: "record.created",
    at: "2026-11-20T10:00:00.000Z",
    subject: { type: "company", id: "co_1" },
    subjectKey: "company:co_1",
    personId: null,
    productUserId: null,
    fieldId: null,
    agentActionId: null,
    identity: null,
    ideaCredited: null,
    source: { system: "app" },
    actor: { type: "member", id: "uid_1" },
    refs: null,
    properties: { object: "company", via: "form" },
    createdAt: "2026-11-20T10:00:01.000Z",
    blankedAt: null,
    blankedReason: null,
    ...over,
  });

  it("takes the person from personId and keeps the subject", () => {
    const e = fromStoredEvent(row({ subject: { type: "person", id: PERSON }, subjectKey: `person:${PERSON}`, personId: PERSON }));
    expect(e.person).toBe(PERSON);
    expect(e.subject).toEqual({ type: "person", id: PERSON });
    expect(e.refs).toEqual({});
  });

  it("has no person for a company's row, and keeps its kind, time and actor", () => {
    expect(fromStoredEvent(row())).toMatchObject({ kind: "record.created", at: "2026-11-20T10:00:00.000Z", person: null, actor: { type: "member", id: "uid_1" }, subject: { type: "company", id: "co_1" } });
  });
});

describe("fromWorkLog", () => {
  const base = {
    id: "wl_0123456789abcdef01234567",
    organisationId: "org_ten_lumen",
    brandId: "ten_lumen",
    region: "us" as const,
    day: "2026-11-20",
    at: "2026-11-20T09:00:00.000Z",
    source: { who: { kind: "person" as const, id: "uid_nina" }, tool: "work_page", session: null },
  };
  const TASK = "wt_aaaaaaaaaaaaaaaaaaab";
  const rows: WorkLogRow[] = [
    { ...base, kind: "entry", taskId: null, workstream: "Onboarding emails", state: "doing", note: "Drafted two.", links: [] },
    { ...base, kind: "change", taskId: TASK, field: "added", before: null, after: { ref: 73, title: "Add a G2 listing", origin: "suggestion" } },
    { ...base, kind: "change", taskId: TASK, field: "status", before: "todo", after: "done", source: { ...base.source, tool: "import" } },
    {
      ...base,
      kind: "check",
      taskId: TASK,
      check: { action: "read", kind: "date", at: base.at, next: null, measureKind: "used", which: "first", counted: { n: 212, from: base.at, to: base.at, at: base.at }, read: "better" },
    },
    {
      ...base,
      kind: "decision",
      taskId: TASK,
      source: { who: { kind: "vizzy", id: null }, tool: "draft_work_decision", session: null },
      decision: {
        question: "Approve the plan",
        options: [
          { id: "a", label: "Approve" },
          { id: "b", label: "Change it" },
          { id: "c", label: "Not now" },
        ],
        recommended: null,
        chosen: { option: "a", by: "uid_nina" },
        agreed: null,
        why: null,
        replaces: null,
        plan: { url: "https://docs.example.com/plan", version: "v2" },
      },
    },
  ];

  it("maps every kind of row, each one a valid row, to a work kind the envelope has and never stores", () => {
    for (const r of rows) expect(WorkLogRowSchema.safeParse(r).success, r.kind).toBe(true);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(WORK_LOG_KINDS));
    const kinds = rows.map((r) => fromWorkLog(r).kind);
    expect(kinds).toEqual(["work.logged", "work.task_added", "work.task_changed", "work.checked", "work.decided"]);
    for (const k of kinds) {
      expect(EVENT_KINDS).toContain(k);
      expect(isStoredEventKind(k)).toBe(false);
    }
  });

  it("names no person, keeps the task, brand and organisation in refs, and says who did it", () => {
    const e = fromWorkLog(rows[2]!);
    expect(e).toMatchObject({ id: base.id, at: base.at, person: null, identity: null, ideaCredited: null, source: { system: "app" }, actor: { type: "member", id: "uid_nina" } });
    expect(e.refs).toEqual({ organisationId: "org_ten_lumen", brandId: "ten_lumen", taskId: TASK });
    expect(e).not.toHaveProperty("subject");
    expect(fromWorkLog(rows[4]!)).toMatchObject({ source: { system: "agent" }, actor: { type: "agent", id: "vizzy" } });
    expect(fromWorkLog({ ...rows[0]!, brandId: null }).refs).toEqual({ organisationId: "org_ten_lumen" });
  });

  it("shapes a change like record.field_changed, and an added task by its origin's kind", () => {
    expect(fromWorkLog(rows[2]!).properties).toEqual({ field: "status", before: "todo", after: "done", source: "import" });
    expect(fromWorkLog(rows[1]!).properties).toMatchObject({ origin: "suggestion", ref: 73 });
  });

  it("carries the measure's kind and the read on a check, and says when a decision approves a plan", () => {
    expect(fromWorkLog(rows[3]!).properties).toMatchObject({ action: "read", measureKind: "used", which: "first", read: "better", counted: 212 });
    // A count from the learning loops' counts across brands is for operators, so the event leaves it out.
    const check = rows[3] as Extract<WorkLogRow, { kind: "check" }>;
    const across = { ...check, check: { ...check.check, counted: { n: 1800, from: base.at, to: base.at, at: base.at, weeks: { read: 2, shown: 2, orgs: 12, open: 0, older: 0 } } } };
    expect(WorkLogRowSchema.safeParse(across).success).toBe(true);
    expect(fromWorkLog(across).properties).toMatchObject({ counted: null });
    expect(fromWorkLog(rows[4]!).properties).toMatchObject({ planApproval: true, agreed: null, chosen: "a", recommendedBy: null });
    expect(fromWorkLog(rows[0]!).properties).toEqual({ workstream: "Onboarding emails", state: "doing", tool: "work_page" });
  });
});
