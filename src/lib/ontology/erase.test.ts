import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvents, eraseHistory, proposeAgentAction, transitionAgentAction } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { eraseProductUser } from "@/lib/connect/erase";
import { productUserDocId } from "@/lib/connect/profile";
import { patchUser } from "@/lib/connect/v2/users";
import { recordSignupContact } from "@/lib/crm/contactService";
import { personIdOf, syncPerson } from "@/lib/audience/personSync";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { agentDedupeKey } from "@/lib/types/agentAction";
import type { Campaign } from "@/lib/types/campaign";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { Signup } from "@/lib/types/signup";
import { fieldChangedEvent } from "./eventBuilders";
import { forgetGonePersonHistory, productUserPersonId } from "./erase";
import type { ContactPersonId } from "./person";

/**
 * Erasing the event history and agent actions of people reached through a product user, with
 * every switch off unless a case says otherwise. Addresses are .test.
 */

const AT = "2026-09-21T08:00:00.000Z";
const MEMBER = { type: "member" as const, id: "usr_1" };
const OTHER: TenantContext = { tenantId: "ten_other", region: "eu", source: "system" };
const person = (key: string) => personIdOf(TENANT_ID, key) as ContactPersonId;

/** One field change and one open suggestion about a person; the change can name a product user. */
async function rowsAbout(db: FakeFirestore, c: TenantContext, personId: ContactPersonId, key: string, productUserId?: string) {
  await appendEvents(
    c,
    [
      fieldChangedEvent({
        subject: { type: "person", id: personId },
        personId,
        productUserId: productUserId ?? null,
        fieldId: "plan",
        object: "person",
        before: null,
        after: "pro",
        source: "editor",
        actor: MEMBER,
        at: AT,
        nonce: () => key,
      }),
    ],
    { db },
  );
  await proposeAgentAction(
    c,
    {
      dedupeKey: agentDedupeKey("person_fields.suggest", key),
      agent: "vizzy",
      action: "person_fields.suggest",
      target: { type: "person", id: personId },
      personId,
      proposal: { fields: { plan: "pro" } },
      basis: null,
      signals: [],
      review: null,
      requestedBy: MEMBER,
      expiresAt: "2026-10-21T08:00:00.000Z",
      at: AT,
    },
    { db },
  );
}

/** How many history rows (events and actions) a brand holds for a person. */
function held(db: FakeFirestore, tenantId: string, personId: string): number {
  const mine = (r: Record<string, unknown>) => r.tenantId === tenantId && r.personId === personId;
  return db.dump("ontology_events").filter(mine).length + db.dump("agent_actions").filter(mine).length;
}

const connectionOf = (db: FakeFirestore) => ({ id: CONNECTION_ID, ...(db.raw("product_connections", CONNECTION_ID) as object) }) as ProductConnection;

function stubSwitches(links: "true" | "false", oneView: "true" | "false") {
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", links);
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", oneView);
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
}

afterEach(() => vi.unstubAllEnvs());

describe("productUserPersonId", () => {
  it("is the id of the product user's own pu: person", () => {
    expect(productUserPersonId(TENANT_ID, "pu_1")).toBe(personIdOf(TENANT_ID, "pu:pu_1"));
    expect(productUserPersonId(TENANT_ID, "pu_1")).toMatch(/^ct_[0-9a-f]{40}$/);
  });
});

describe("forgetGonePersonHistory", () => {
  beforeEach(() => stubSwitches("false", "false"));

  it("erases both stores for a person whose record is gone, and nothing for one still there or no key", async () => {
    const db = new FakeFirestore();
    const gone = person("gone@customer.test");
    const kept = person("kept@customer.test");
    await rowsAbout(db, ctx, gone, "g1");
    await rowsAbout(db, ctx, kept, "k1");
    db.seed("contacts", kept, { tenantId: TENANT_ID, email: "kept@customer.test" });
    await rowsAbout(db, OTHER, gone, "o1");

    expect(await forgetGonePersonHistory(ctx, "gone@customer.test", { db })).toEqual({ events: 2, agentActions: 1 });
    expect(held(db, TENANT_ID, gone)).toBe(0);
    expect(await forgetGonePersonHistory(ctx, "kept@customer.test", { db })).toEqual({ events: 0, agentActions: 0 });
    expect(held(db, TENANT_ID, kept)).toBe(3);
    expect(await forgetGonePersonHistory(ctx, null, { db })).toBeNull();
    expect(held(db, "ten_other", gone)).toBe(3);
  });
});

describe("eraseHistory by record", () => {
  it("removes the actions about a company, their agent rows and the company's events, and nothing else", async () => {
    const db = new FakeFirestore();
    const company = { type: "company" as const, id: "co_1" };
    const companyEvent = fieldChangedEvent({ subject: company, personId: null, fieldId: "size", object: "company", before: 1, after: 2, source: "editor", actor: MEMBER, at: AT, nonce: () => "c1" });
    const otherCompany = fieldChangedEvent({ subject: { type: "company", id: "co_2" }, personId: null, fieldId: "size", object: "company", before: 1, after: 2, source: "editor", actor: MEMBER, at: AT, nonce: () => "c2" });
    await appendEvents(ctx, [companyEvent, otherCompany], { db });
    const { action } = await proposeAgentAction(
      ctx,
      {
        dedupeKey: agentDedupeKey("company_fields.suggest", "co_1"),
        agent: "vizzy",
        action: "company_fields.suggest",
        target: company,
        personId: null,
        proposal: null,
        basis: null,
        signals: [],
        review: null,
        requestedBy: MEMBER,
        expiresAt: "2026-10-21T08:00:00.000Z",
        at: AT,
      },
      { db },
    );
    await transitionAgentAction(ctx, action.id, { to: "declined", reason: "dismissed", by: MEMBER, at: "2026-09-22T08:00:00.000Z" }, { db });
    const ada = person("ada@customer.test");
    await rowsAbout(db, ctx, ada, "a1");

    expect(await eraseHistory(ctx, { recordKey: "company:co_1" }, { db })).toEqual({ events: 3, agentActions: 1 });
    expect(db.raw("agent_actions", action.id)).toBeUndefined();
    expect(db.dump("ontology_events").filter((r) => r.agentActionId === action.id || r.subjectKey === "company:co_1")).toEqual([]);
    expect(db.dump("ontology_events").filter((r) => r.subjectKey === "company:co_2")).toHaveLength(1);
    expect(held(db, TENANT_ID, ada)).toBe(3);
  });
});

describe("eraseProductUser", () => {
  it("with every switch off: removes rows naming the product user and its pu: person, and keeps the person's own", async () => {
    stubSwitches("false", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    await patchUser(ctx, connectionOf(db), "ada", { email: "ada@customer.test" }, { db, nowMs: T0 });
    const puId = productUserDocId(CONNECTION_ID, "ada");
    const ada = person("ada@customer.test");
    // Ada is a person through a waitlist sign-up, so her record stays after the product erase.
    db.seed("contacts", ada, { tenantId: TENANT_ID, email: "ada@customer.test", campaigns: [{ campaignId: "camp1", signupId: "sig_1" }] });
    await rowsAbout(db, ctx, ada, "about_her_product", puId);
    await rowsAbout(db, ctx, ada, "about_her", undefined);
    await rowsAbout(db, ctx, productUserPersonId(TENANT_ID, puId), "before_her_address");
    await rowsAbout(db, OTHER, productUserPersonId(TENANT_ID, puId), "theirs", puId);

    expect(await eraseProductUser(ctx, CONNECTION_ID, puId, db, T0 + 1000)).toBe(true);
    expect(db.dump("ontology_events").filter((r) => r.tenantId === TENANT_ID && r.productUserId === puId)).toEqual([]);
    expect(held(db, TENANT_ID, productUserPersonId(TENANT_ID, puId))).toBe(0);
    // Her own rows stay with her: both suggestions with their rows, and the change that named no product.
    expect(held(db, TENANT_ID, ada)).toBe(5);
    expect(held(db, "ten_other", productUserPersonId(TENANT_ID, puId))).toBe(3);
  });

  it("removes the person's rows when their record went with their last product user", async () => {
    stubSwitches("true", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    await patchUser(ctx, connectionOf(db), "bea", { email: "bea@customer.test" }, { db, nowMs: T0 });
    const bea = person("bea@customer.test");
    expect(db.raw("contacts", bea)).toBeDefined();
    await rowsAbout(db, ctx, bea, "b1");
    expect(await eraseProductUser(ctx, CONNECTION_ID, productUserDocId(CONNECTION_ID, "bea"), db, T0 + 1000)).toBe(true);
    expect(db.raw("contacts", bea)).toBeUndefined();
    expect(held(db, TENANT_ID, bea)).toBe(0);
  });

  it("removes the person's rows when the sync fails at the erase and their record only goes at the sweep", async () => {
    stubSwitches("true", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    await patchUser(ctx, connectionOf(db), "bea", { email: "bea@customer.test" }, { db, nowMs: T0 });
    const bea = person("bea@customer.test");
    await rowsAbout(db, ctx, bea, "b1");
    const open = db.collection.bind(db);
    let outage = true;
    vi.spyOn(db, "collection").mockImplementation((name: string) => {
      if (name === "signups" && outage) {
        outage = false;
        throw new Error("unavailable");
      }
      return open(name);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await eraseProductUser(ctx, CONNECTION_ID, productUserDocId(CONNECTION_ID, "bea"), db, T0 + 1000)).toBe(true);
    // The sync failed, so the record waits for the sweep; their history is gone already.
    expect(db.raw("contacts", bea)).toMatchObject({ needsSync: true });
    expect(held(db, TENANT_ID, bea)).toBe(0);
    expect((await syncPerson(ctx, "bea@customer.test", { db, nowMs: T0 + 2000 })).outcome).toBe("deleted");
    expect(held(db, TENANT_ID, bea)).toBe(0);
  });

  it("removes the person's rows when person links are off at the erase and the record goes later", async () => {
    stubSwitches("true", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    await patchUser(ctx, connectionOf(db), "bea", { email: "bea@customer.test" }, { db, nowMs: T0 });
    const bea = person("bea@customer.test");
    await rowsAbout(db, ctx, bea, "b1");
    stubSwitches("false", "false");
    expect(await eraseProductUser(ctx, CONNECTION_ID, productUserDocId(CONNECTION_ID, "bea"), db, T0 + 1000)).toBe(true);
    expect(db.raw("contacts", bea)).toBeDefined();
    expect(held(db, TENANT_ID, bea)).toBe(0);
    stubSwitches("true", "false");
    expect((await syncPerson(ctx, "bea@customer.test", { db, nowMs: T0 + 2000 })).outcome).toBe("deleted");
    expect(held(db, TENANT_ID, bea)).toBe(0);
  });

  it("keeps the person's rows while another product user still has the address, with or without a record", async () => {
    stubSwitches("false", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    await patchUser(ctx, connectionOf(db), "bea", { email: "bea@customer.test" }, { db, nowMs: T0 });
    await patchUser(ctx, connectionOf(db), "bea_work", { email: "bea@customer.test" }, { db, nowMs: T0 });
    const bea = person("bea@customer.test");
    expect(db.raw("contacts", bea)).toBeUndefined();
    await rowsAbout(db, ctx, bea, "b1");
    expect(await eraseProductUser(ctx, CONNECTION_ID, productUserDocId(CONNECTION_ID, "bea"), db, T0 + 1000)).toBe(true);
    expect(held(db, TENANT_ID, bea)).toBe(3);
  });

  it("after a merge with ONTOLOGY_PERSON_IDS_ENABLED off: reaches the pu: person's rows from the product user", async () => {
    stubSwitches("true", "true");
    const db = new FakeFirestore();
    seedWorld(db);
    const signup = { tenantId: TENANT_ID, campaignId: "camp1", email: "cal@customer.test", status: "verified_active", verified: true, createdAt: AT } as unknown as Signup;
    db.seed("signups", "sig_cal", signup);
    await recordSignupContact(ctx, {} as Campaign, { ...signup, id: "sig_cal" }, db);
    await patchUser(ctx, connectionOf(db), "anon", {}, { db, nowMs: T0 });
    const puId = productUserDocId(CONNECTION_ID, "anon");
    const puPerson = productUserPersonId(TENANT_ID, puId);
    expect(db.raw("contacts", puPerson)).toBeDefined();
    // Rows about the pu: person carry only its person id, no product user.
    await rowsAbout(db, ctx, puPerson, "pu_rows");
    await patchUser(ctx, connectionOf(db), "anon", { email: "cal@customer.test" }, { db, nowMs: T0 + 1000 });
    expect(db.raw("contacts", puPerson)).toBeUndefined();
    expect(held(db, TENANT_ID, puPerson)).toBe(3);

    expect(await eraseProductUser(ctx, CONNECTION_ID, puId, db, T0 + 2000)).toBe(true);
    expect(held(db, TENANT_ID, puPerson)).toBe(0);
  });
});
