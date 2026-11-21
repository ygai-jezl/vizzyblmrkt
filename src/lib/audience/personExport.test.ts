import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvents, proposeAgentAction } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { productUserPersonId } from "@/lib/ontology/erase";
import type { ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey } from "@/lib/types/agentAction";
import { T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { exportPerson, exportWholePerson, PERSON_EXPORT_FORMAT, WHOLE_PERSON_EXPORT_FORMAT } from "./personExport";
import { personIdOf, syncPerson } from "./personSync";

/** A whole person's export, from made-up people at .test. */

describe("exportWholePerson", () => {
  it("holds their record, every sign-up (without its confirmation token), their launch emails and each product's export", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("signups", "s_ada", {
      tenantId: TENANT_ID,
      campaignId: "camp1",
      email: "ada@customer.test",
      status: "unverified",
      verificationToken: "secret-token",
      amountReferred: 0,
      referralToken: "r",
      referralLink: "https://example.test/r",
      score: 0,
      createdAt: new Date(T0).toISOString(),
    });
    db.seed("email_events", "ev1", { tenantId: TENANT_ID, signupId: "s_ada", type: "open" });
    db.seed("invites", "inv_1", { tenantId: TENANT_ID, signupId: "s_ada", campaignId: "camp1" });
    db.seed("waitlist_enrolments", "enr_1", { tenantId: TENANT_ID, signupId: "s_ada", status: "active" });
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });

    const r = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
    expect(r.found).toBe(true);
    const doc = (r as { document: Record<string, unknown> }).document;
    expect(doc).toMatchObject({ format: WHOLE_PERSON_EXPORT_FORMAT, complete: true, person: { email: "ada@customer.test" } });
    expect((doc.person as Record<string, unknown>).searchTokens).toBeUndefined();
    expect((doc.person as Record<string, unknown>).tenantId).toBeUndefined();
    const signups = doc.signups as Array<Record<string, unknown>>;
    expect(signups).toHaveLength(1);
    expect(signups[0]!.verificationToken).toBeUndefined();
    expect(doc.launchEmails).toHaveLength(1);
    expect(doc.invites).toHaveLength(1);
    expect(doc.waitlistJourneys).toHaveLength(1);
    expect(doc.products).toEqual([expect.objectContaining({ format: PERSON_EXPORT_FORMAT })]);
    expect(JSON.stringify(doc.products)).toContain(ada.id);
    // A product user with their address that the record doesn't link yet is theirs too.
    const other = seedUser(db, "ada-2", { connectionId: "pcn_other", email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    const again = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
    expect(JSON.stringify((again as { document: Record<string, unknown> }).document.products)).toContain(other.id);
    expect((await exportWholePerson({ ...ctx, tenantId: "ten_other" }, personIdOf(TENANT_ID, "ada@customer.test"), { db })).found).toBe(false);
  });
});

describe("person moves in an export", () => {
  function moves(db: FakeFirestore, productUserId: string, to: string, from: string) {
    const row = (over: Record<string, unknown>) => ({
      tenantId: TENANT_ID,
      kind: "record.repointed",
      productUserId,
      connectionId: "pcn_life",
      repoint: "done",
      at: new Date(T0).toISOString(),
      createdAt: new Date(T0).toISOString(),
      ...over,
    });
    db.seed("person_moves", "mv_to", row({ personId: to, fromPersonId: from }));
    db.seed("person_moves", "mv_from", row({ personId: from, fromPersonId: to }));
    db.seed("person_moves", "mv_other", row({ productUserId: "pu_someone_else", personId: "ct_x", fromPersonId: "ct_y" }));
    db.seed("person_moves", "mv_theirs", row({ tenantId: "ten_other", personId: to, fromPersonId: from }));
  }

  it("a product user's export has their moves", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    moves(db, ada.id, person, personIdOf(TENANT_ID, "old@customer.test"));
    const r = await exportPerson(ctx, ada.id, { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect((doc.moves as Array<Record<string, unknown>>).map((m) => m.id).sort()).toEqual(["mv_from", "mv_to"]);
    expect(doc.complete).toBe(true);
    // A section that comes back full says so.
    const capped = await exportPerson(ctx, ada.id, { db, nowMs: T0, limits: { moves: 1 } });
    expect((capped as { document: Record<string, unknown> }).document).toMatchObject({ complete: false, truncated: { moves: expect.any(String) } });
  });

  it("a whole person's export has the moves to and from them", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    moves(db, "pu_gone", person, personIdOf(TENANT_ID, "old@customer.test"));
    const r = await exportWholePerson(ctx, person, { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect((doc.moves as Array<Record<string, unknown>>).map((m) => m.id).sort()).toEqual(["mv_from", "mv_to"]);
    expect(JSON.stringify(doc.moves)).not.toContain("ten_other");
  });
});

describe("event history and agent actions in an export, with every switch off", () => {
  const AT = "2026-09-21T08:00:00.000Z";
  const MEMBER = { type: "member" as const, id: "usr_1" };
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  /** One field change about a person (naming a product user when given); returns its key. */
  async function change(db: FakeFirestore, personId: string, key: string, productUserId?: string): Promise<string> {
    const e = fieldChangedEvent({
      subject: { type: "person", id: personId },
      personId: personId as ContactPersonId,
      productUserId: productUserId ?? null,
      fieldId: "plan",
      object: "person",
      before: null,
      after: "pro",
      source: "editor",
      actor: MEMBER,
      at: AT,
      nonce: () => key,
    });
    await appendEvents(ctx, [e], { db });
    return e.key;
  }
  async function suggestion(db: FakeFirestore, personId: string, key: string): Promise<string> {
    const { action } = await proposeAgentAction(
      ctx,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", key),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: personId },
        personId: personId as ContactPersonId,
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
    return action.id;
  }
  const keys = (rows: unknown) => (rows as Array<Record<string, unknown>>).map((r) => String(r.key ?? r.id)).sort();

  it("a whole person's export has their rows, each once: one already in a product's section is not repeated", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    const own = await change(db, person, "own");
    const viaProduct = await change(db, person, "via_product", ada.id);
    const action = await suggestion(db, person, "s1");
    await change(db, personIdOf(TENANT_ID, "bo@customer.test"), "someone_else");

    const doc = ((await exportWholePerson(ctx, person, { db, nowMs: T0 })) as { document: Record<string, unknown> }).document;
    expect(keys(doc.events)).toEqual([`agent|${action}|1`, own].sort());
    expect(keys(doc.agentActions)).toEqual([action]);
    const product = (doc.products as Array<Record<string, unknown>>)[0]!;
    expect(keys(product.events)).toEqual([viaProduct]);
    expect(doc.complete).toBe(true);
    expect(JSON.stringify(doc.events)).not.toContain("tenantId");
  });

  it("after a pu: merge, the whole person's export shows the pu: rows in that product's section", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const anon = seedUser(db, "anon", { email: null, emailNormalized: null });
    const puPerson = productUserPersonId(TENANT_ID, anon.id);
    const before = await change(db, puPerson, "before_address");
    // They give an address: the sync moves them to the address's person, and the pu: record goes.
    db.seed("product_users", anon.id, { ...db.raw("product_users", anon.id), email: "cal@customer.test", emailNormalized: "cal@customer.test" });
    await syncPerson(ctx, "cal@customer.test", { db, nowMs: T0 });
    const doc = ((await exportWholePerson(ctx, personIdOf(TENANT_ID, "cal@customer.test"), { db, nowMs: T0 })) as { document: Record<string, unknown> }).document;
    const product = (doc.products as Array<Record<string, unknown>>)[0]!;
    expect(keys(product.events)).toEqual([before]);
    expect(doc.events).toEqual([]);
  });

  it("a product user's export has their rows, their pu: person's, and a removed product-only person's", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const bea = seedUser(db, "bea", { email: "bea@customer.test", emailNormalized: "bea@customer.test" });
    const beaPerson = personIdOf(TENANT_ID, "bea@customer.test");
    const named = await change(db, beaPerson, "named", bea.id);
    const pu = await change(db, productUserPersonId(TENANT_ID, bea.id), "pu");
    const person = await change(db, beaPerson, "person");
    const action = await suggestion(db, productUserPersonId(TENANT_ID, bea.id), "pu_suggestion");

    // No person record for her address: a sync removed it (her product was revoked), so her person's rows are hers too.
    const gone = ((await exportPerson(ctx, bea.id, { db, nowMs: T0 })) as { document: Record<string, unknown> }).document;
    expect(keys(gone.events)).toEqual([named, pu, person, `agent|${action}|1`].sort());
    expect(keys(gone.agentActions)).toEqual([action]);

    // With the record there, the person's own rows belong to the person's export instead.
    await syncPerson(ctx, "bea@customer.test", { db, nowMs: T0 });
    const kept = ((await exportPerson(ctx, bea.id, { db, nowMs: T0 })) as { document: Record<string, unknown> }).document;
    expect(keys(kept.events)).toEqual([named, pu, `agent|${action}|1`].sort());
  });

  it("says when a history section reached its limit", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    await change(db, person, "one", ada.id);
    await change(db, person, "two");
    await suggestion(db, person, "s1");
    const product = ((await exportPerson(ctx, ada.id, { db, nowMs: T0, limits: { events: 1 } })) as { document: Record<string, unknown> }).document;
    expect(product).toMatchObject({ complete: false, truncated: { events: expect.any(String) } });
    const whole = ((await exportWholePerson(ctx, person, { db, nowMs: T0, limits: { events: 1, agentActions: 1 } })) as { document: Record<string, unknown> }).document;
    expect(whole).toMatchObject({ complete: false, truncated: { events: expect.any(String), agentActions: expect.any(String) } });
  });
});

describe("field values in an export, with every switch off", () => {
  it("lists each value with its field's label, archived ones marked, beside their field changes", async () => {
    const { saveFieldListChange } = await import("./fieldList");
    const { setRecordFieldValues } = await import("@/lib/tenant");
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const id = personIdOf(TENANT_ID, "ada@customer.test");
    const by = { type: "member", id: "u_admin" } as const;
    const at = new Date(T0).toISOString();
    await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Plan", type: "select", options: ["Pro"] }, by, nowIso: at, newFieldId: () => "fld_000000000001", newOptionId: () => "opt_00000001" }, db);
    await saveFieldListChange(ctx, "person", { baseRev: 1, change: { op: "add", label: "Old segment", type: "text" }, by, nowIso: at, newFieldId: () => "fld_000000000002" }, db);
    await setRecordFieldValues(ctx, { object: "person", recordId: id, changes: { fld_000000000001: "opt_00000001", fld_000000000002: "B2B" }, by, source: "editor", nowIso: at }, { db });
    await saveFieldListChange(ctx, "person", { baseRev: 2, change: { op: "archive", key: "fld_000000000002" }, by, nowIso: at }, db);

    const r = await exportWholePerson(ctx, id, { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect(doc.fields).toEqual([
      { fieldId: "fld_000000000001", label: "Plan", type: "select", typeLabel: "select", archived: false, value: "opt_00000001", text: "Pro" },
      { fieldId: "fld_000000000002", label: "Old segment", type: "text", typeLabel: "text", archived: true, value: "B2B", text: "B2B" },
    ]);
    expect((doc.events as Array<{ kind: string }>).filter((e) => e.kind === "record.field_changed")).toHaveLength(2);
  });

  it("has no field values for someone without any", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const r = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
    expect((r as { document: Record<string, unknown> }).document.fields).toEqual([]);
  });
});

describe("someone added by hand in an export, with every switch off", () => {
  it("holds who added them, how they agreed and both events, and no address in the events", async () => {
    const { addPerson } = await import("./addPerson");
    const { parseNewPerson } = await import("./newPerson");
    const db = new FakeFirestore();
    seedWorld(db);
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam", agreed: { how: "signed_form" } });
    if (!sam.ok) throw new Error(sam.error);
    const at = new Date(T0).toISOString();
    await addPerson(ctx, sam.value, { db, nowIso: at });
    const r = await exportWholePerson(ctx, personIdOf(TENANT_ID, "sam@labs.test"), { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect(doc.person).toMatchObject({
      email: "sam@labs.test",
      addedBy: { kind: "member", id: "usr_1", at, via: "form" },
      consent: { marketing_email: { state: "granted", how: "signed_form", recordedBy: "usr_1", at } },
    });
    const kinds = (doc.events as Array<{ kind: string }>).map((e) => e.kind).sort();
    expect(kinds).toEqual(["consent.recorded", "record.created"]);
    expect(JSON.stringify(doc.events)).not.toContain("sam@labs.test");
  });
});

describe("timeline moves in an export, with the timeline switched off again", () => {
  it("are in the export: a product's in that product's part, with its product user", async () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_TIMELINE_ENABLED", "true");
    try {
      const db = new FakeFirestore();
      seedWorld(db);
      seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
      await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
      vi.unstubAllEnvs();
      const r = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
      const doc = (r as unknown as { document: { events: Array<{ fieldId: string | null }>; products: Array<{ events: Array<{ fieldId: string | null }> }> } }).document;
      const inProducts = doc.products.flatMap((x) => x.events).map((e) => e.fieldId);
      expect(inProducts.filter((f) => f?.startsWith("sys.")).sort()).toEqual(["sys.product.pcn_life", "sys.stage.pcn_life"]);
      expect(doc.events.filter((e) => e.fieldId?.startsWith("sys."))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
