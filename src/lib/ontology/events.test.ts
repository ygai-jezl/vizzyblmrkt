import { describe, expect, it } from "vitest";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { TenantContext } from "@/lib/tenant/types";
import { EmailEventType, type EmailEvent } from "@/lib/types/emailEvent";
import { ProductEventSchema, type ProductEvent } from "@/lib/types/productEvent";
import {
  actorOf,
  EMAIL_EVENT_KIND,
  EVENT_KINDS,
  fromEmailEvent,
  fromPersonMove,
  fromProductEvent,
  isEventKind,
  PRODUCT_EVENT_KIND,
  type AgentActionEvent,
  type EventKind,
} from "./events";
import type { ContactPersonId } from "./person";

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
      properties: { agent: "vizzy", action: "draft_article", target: { type: "idea", id: "c1" }, draft: { kind: "content_plan", ref: "p1" } },
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
