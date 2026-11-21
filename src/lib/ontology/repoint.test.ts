import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvents, forTenant, proposeAgentAction } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { personIdOf } from "@/lib/audience/personSync";
import { personIdForAddress } from "./personRef";
import { HISTORY_STORES, MAX_VALUE_TRIES, processPersonRepointJob, REPOINT_STORES } from "./repoint";
import { fieldChangedEvent } from "./eventBuilders";
import type { ContactPersonId } from "./person";
import { agentDedupeKey } from "@/lib/types/agentAction";
import { saveFieldListChange, type FieldListChange } from "@/lib/audience/fieldList";

// The external audience is out of scope for the erase checks below.
vi.mock("@/lib/mailchimp", () => ({ removeSignupFromAudience: vi.fn(async () => ({ ok: true })) }));

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const T = Date.parse("2026-11-20T10:00:00Z");
const OLD = personIdOf("ten_demo", "pu:pu_1");
const ADA = personIdForAddress("ten_demo", "ada@example.com")!;
const NEW = personIdForAddress("ten_demo", "ada@new.example.com")!;

/** The five stores, and the field that names the product user on each. */
const COLLECTIONS = [
  ["product_events", "productUserId"],
  ["lifecycle_enrolments", "productUserId"],
  ["person_plans", "productUserId"],
  ["email_sends", "signupId"],
  ["email_events", "signupId"],
] as const;

function world(opts: { rowsEach?: number } = {}) {
  const db = new FakeFirestore();
  db.seed("product_connections", "pcn_1", { tenantId: "ten_demo", kind: "custom", status: "active" });
  db.seed("product_users", "pu_1", { tenantId: "ten_demo", connectionId: "pcn_1", status: "active", emailNormalized: "ada@example.com" });
  for (const [col, field] of COLLECTIONS) {
    for (let i = 0; i < (opts.rowsEach ?? 3); i += 1) db.seed(col, `${col}_pu1_${i}`, { tenantId: "ten_demo", [field]: "pu_1", personId: OLD });
    // Someone else in this brand, and another brand's row that happens to name the same id.
    db.seed(col, `${col}_pu2`, { tenantId: "ten_demo", [field]: "pu_2", personId: OLD });
    db.seed(col, `${col}_theirs`, { tenantId: "ten_other", [field]: "pu_1", personId: OLD });
  }
  db.seed("person_moves", "mv_1", { tenantId: "ten_demo", productUserId: "pu_1", personId: ADA, fromPersonId: OLD, repoint: "pending", kind: "record.merged", createdAt: new Date(T).toISOString() });
  db.seed("person_moves", "mv_2", { tenantId: "ten_demo", productUserId: "pu_2", personId: ADA, fromPersonId: OLD, repoint: "pending", kind: "record.merged", createdAt: new Date(T).toISOString() });
  db.seed("email_jobs", "pr_1", { tenantId: "ten_demo", type: "person_repoint", status: "processing", payload: { productUserId: "pu_1" } });
  const job = async () => (await forTenant(ctx, db).emailJobs.getById("pr_1")) as EmailJob;
  /** The person on each of pu_1's rows in a collection, in id order. */
  const people = (col: string) =>
    [...db.cols.get(col)!.entries()]
      .filter(([id]) => id.startsWith(`${col}_pu1_`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row.personId);
  return { db, job, people };
}

describe("processPersonRepointJob", () => {
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("walks the stores in order", () => {
    expect(REPOINT_STORES.map((s) => s.store)).toEqual(["productEvents", "lifecycleEnrolments", "personPlans", "emailSends", "emailEvents"]);
  });

  it("moves only that product user's rows in all five stores, across page boundaries, and marks their moves done", async () => {
    const w = world({ rowsEach: 5 });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T, pageSize: 2 })).toBe("drop");
    for (const [col] of COLLECTIONS) {
      expect(w.people(col), col).toEqual([ADA, ADA, ADA, ADA, ADA]);
      expect(w.db.raw(col, `${col}_pu2`)?.personId, col).toBe(OLD);
      expect(w.db.raw(col, `${col}_theirs`)?.personId, col).toBe(OLD);
    }
    expect(w.db.raw("person_moves", "mv_1")).toMatchObject({ repoint: "done", personId: ADA, fromPersonId: OLD, kind: "record.merged" });
    expect(w.db.raw("person_moves", "mv_2")).toMatchObject({ repoint: "pending" });
  });

  it("changes nothing on a second run", async () => {
    const w = world();
    await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T });
    const writes = () => COLLECTIONS.map(([col]) => [0, 1, 2].map((i) => w.db.writeCountFor(col, `${col}_pu1_${i}`)));
    const before = writes();
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(writes()).toEqual(before);
  });

  it("ends on the person they belong to now, whatever job it is and whenever it runs", async () => {
    const w = world();
    // The job was queued for an earlier move; they have moved again since.
    w.db.seed("product_users", "pu_1", { ...w.db.raw("product_users", "pu_1")!, emailNormalized: "ada@new.example.com" });
    await forTenant(ctx, w.db).emailJobs.update("pr_1", { payload: { productUserId: "pu_1", cursor: { store: "emailSends", after: null, target: ADA } } });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    // The old cursor was for someone else: the walk started over, so every store has the new person.
    for (const [col] of COLLECTIONS) expect(w.people(col), col).toEqual([NEW, NEW, NEW]);
  });

  it("starts over when they move while it runs", async () => {
    const w = world({ rowsEach: 4 });
    let ticks = 0;
    const now = () => {
      ticks += 1;
      // After a few pages, their address changes.
      if (ticks === 4) w.db.seed("product_users", "pu_1", { ...w.db.raw("product_users", "pu_1")!, emailNormalized: "ada@new.example.com" });
      return T;
    };
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now, pageSize: 2 })).toBe("drop");
    for (const [col] of COLLECTIONS) expect(w.people(col), col).toEqual([NEW, NEW, NEW, NEW]);
  });

  it("saves its cursor and asks to go again when the slice runs out, then resumes from it", async () => {
    const w = world({ rowsEach: 4 });
    let clock = T;
    const now = () => (clock += 5_000);
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now, pageSize: 2, sliceMs: 20_000 })).toBe("again");
    const saved = (await w.job()).payload;
    expect(saved).toMatchObject({ productUserId: "pu_1", cursor: { target: ADA } });
    // Three pages a store (two full, one empty), one page a tick: product events are done, enrolments are next.
    expect(saved.cursor).toEqual({ store: "lifecycleEnrolments", after: null, target: ADA });
    expect(w.people("email_events")).toEqual([OLD, OLD, OLD, OLD]);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("pending");

    // The next run picks up where it stopped: the first store is not read again.
    const eventsBefore = w.db.collectionCalls("product_events");
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T, pageSize: 2 })).toBe("drop");
    expect(w.db.collectionCalls("product_events")).toBe(eventsBefore);
    for (const [col] of COLLECTIONS) expect(w.people(col), col).toEqual([ADA, ADA, ADA, ADA]);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("drops itself and writes nothing while the switch is off", async () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    const w = world();
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    for (const [col] of COLLECTIONS) expect(w.people(col)).toEqual([OLD, OLD, OLD]);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("pending");
  });

  it("drops itself for an erased user, a user who isn't a person any more, or no user at all", async () => {
    const erased = world();
    erased.db.seed("product_users", "pu_1", { tenantId: "ten_demo", connectionId: "pcn_1", status: "deleted" });
    expect(await processPersonRepointJob(ctx, await erased.job(), erased.db, { now: () => T })).toBe("drop");
    expect(erased.people("product_events")).toEqual([OLD, OLD, OLD]);

    const revoked = world();
    revoked.db.seed("product_connections", "pcn_1", { tenantId: "ten_demo", kind: "custom", status: "revoked" });
    expect(await processPersonRepointJob(ctx, await revoked.job(), revoked.db, { now: () => T })).toBe("drop");
    expect(revoked.people("product_events")).toEqual([OLD, OLD, OLD]);

    const none = world();
    expect(await processPersonRepointJob(ctx, { ...(await none.job()), payload: {} }, none.db, { now: () => T })).toBe("drop");
    expect(none.db.raw("person_moves", "mv_1")?.repoint).toBe("pending");
  });

  it("marks the moves of a user who can't be a person any more dropped, so the tick stops queueing them", async () => {
    for (const change of ["erased", "revoked", "gone", "no product"] as const) {
      const w = world();
      if (change === "erased") w.db.seed("product_users", "pu_1", { tenantId: "ten_demo", connectionId: "pcn_1", status: "deleted" });
      if (change === "revoked") w.db.seed("product_connections", "pcn_1", { tenantId: "ten_demo", kind: "custom", status: "revoked" });
      if (change === "gone") w.db.cols.get("product_users")!.delete("pu_1");
      if (change === "no product") w.db.cols.get("product_connections")!.delete("pcn_1");
      expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T, pageSize: 1 }), change).toBe("drop");
      expect(w.db.raw("person_moves", "mv_1"), change).toMatchObject({ repoint: "dropped", personId: ADA, fromPersonId: OLD, kind: "record.merged" });
      // Someone else's move is theirs to settle.
      expect(w.db.raw("person_moves", "mv_2")?.repoint, change).toBe("pending");
    }
  });

  it("never reaches another brand's product user", async () => {
    const w = world();
    expect(await processPersonRepointJob({ ...ctx, tenantId: "ten_other" }, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.db.raw("product_events", "product_events_theirs")?.personId).toBe(OLD);
    expect(w.people("product_events")).toEqual([OLD, OLD, OLD]);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("pending");
  });
});

describe("processPersonRepointJob and the history stores", () => {
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const MEMBER = { type: "member" as const, id: "uid_1" };
  const AT = "2026-11-20T09:00:00.000Z";
  const FORMER = personIdForAddress("ten_demo", "ada@old.example.com")!;

  /** A field change filed under a person (naming pu_1 when asked) and an open suggestion about them. */
  async function history(db: ReturnType<typeof world>["db"], c: TenantContext, personKey: string, key: string, productUserId?: string) {
    const person = personKey as ContactPersonId;
    await appendEvents(
      c,
      [fieldChangedEvent({ subject: { type: "person", id: person }, personId: person, productUserId: productUserId ?? null, fieldId: "plan", object: "person", before: null, after: "pro", source: "sync", actor: MEMBER, at: AT, nonce: () => key })],
      { db },
    );
    await proposeAgentAction(
      c,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", key),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: person },
        personId: person,
        proposal: null,
        basis: null,
        signals: [],
        review: null,
        requestedBy: MEMBER,
        expiresAt: "2026-12-20T09:00:00.000Z",
        at: AT,
      },
      { db },
    );
  }
  const filed = (db: ReturnType<typeof world>["db"], tenantId: string, person: string) =>
    [...db.dump("ontology_events"), ...db.dump("agent_actions")].filter((r) => r.tenantId === tenantId && r.personId === person).length;

  it("walks the history stores by their repository keys after the five", () => {
    expect([...HISTORY_STORES]).toEqual(["ontologyEvents", "agentActions"]);
  });

  it("moves the product user's rows, and everything filed under the pu: person they merged from", async () => {
    const w = world();
    await history(w.db, ctx, OLD, "named", "pu_1");
    await history(w.db, ctx, OLD, "filed");
    await history(w.db, { ...ctx, tenantId: "ten_other" }, OLD, "theirs");
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T, pageSize: 2 })).toBe("drop");
    expect(filed(w.db, "ten_demo", OLD)).toBe(0);
    expect(filed(w.db, "ten_demo", ADA)).toBe(6);
    expect(w.db.dump("agent_actions").filter((a) => a.tenantId === "ten_demo").every((a) => a.targetKey === `person:${ADA}`)).toBe(true);
    expect(filed(w.db, "ten_other", OLD)).toBe(3);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("after an address change, moves what was filed under the former person only when their record is gone", async () => {
    const kept = world();
    kept.db.seed("person_moves", "mv_1", { ...kept.db.raw("person_moves", "mv_1")!, kind: "record.repointed", fromPersonId: FORMER });
    kept.db.seed("contacts", FORMER, { tenantId: "ten_demo", email: "ada@old.example.com" });
    await history(kept.db, ctx, FORMER, "former", undefined);
    await history(kept.db, ctx, FORMER, "named_former", "pu_1");
    expect(await processPersonRepointJob(ctx, await kept.job(), kept.db, { now: () => T })).toBe("drop");
    // Their own rows from the product move; the former person's own stay with them.
    expect(filed(kept.db, "ten_demo", FORMER)).toBe(5);
    expect(filed(kept.db, "ten_demo", ADA)).toBe(1);

    const gone = world();
    gone.db.seed("person_moves", "mv_1", { ...gone.db.raw("person_moves", "mv_1")!, kind: "record.repointed", fromPersonId: FORMER });
    await history(gone.db, ctx, FORMER, "former", undefined);
    expect(await processPersonRepointJob(ctx, await gone.job(), gone.db, { now: () => T })).toBe("drop");
    expect(filed(gone.db, "ten_demo", FORMER)).toBe(0);
    expect(filed(gone.db, "ten_demo", ADA)).toBe(3);
  });

  it("resumes a saved cursor inside a history store", async () => {
    const w = world({ rowsEach: 1 });
    await history(w.db, ctx, OLD, "a", "pu_1");
    await history(w.db, ctx, OLD, "b", "pu_1");
    await forTenant(ctx, w.db).emailJobs.update("pr_1", { payload: { productUserId: "pu_1", cursor: { store: "agentActions", after: null, target: ADA, from: OLD } } });
    const eventsBefore = w.db.collectionCalls("product_events");
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    // It started at the agent actions filed under the pu: person, so the five stores were not walked again.
    expect(w.db.collectionCalls("product_events")).toBe(eventsBefore);
    expect(w.db.dump("agent_actions").filter((a) => a.tenantId === "ten_demo").every((a) => a.personId === ADA)).toBe(true);
  });
});

describe("processPersonRepointJob and the team's field values", () => {
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const BY = { type: "member" as const, id: "uid_1" };
  const AT = "2026-11-20T09:00:00.000Z";
  const PLAN = "fld_000000000001";
  const SEATS = "fld_000000000002";
  const FORMER = personIdForAddress("ten_demo", "ada@old.example.com")!;

  /**
   * pu_1 moved to `to` (its product user now has that address) from `from`, a record left behind
   * holding the team's values; `to` holds `theirs`. The field list has Plan and Seats.
   */
  async function valuesWorld(a: { kind: "record.merged" | "record.repointed"; from: ContactPersonId; fromKey: string; to: ContactPersonId; toKey: string; theirs?: Record<string, unknown> }) {
    const db = new FakeFirestore();
    db.seed("product_connections", "pcn_1", { tenantId: "ten_demo", kind: "custom", status: "active" });
    db.seed("product_users", "pu_1", { tenantId: "ten_demo", connectionId: "pcn_1", status: "active", emailNormalized: a.toKey });
    let o = 0;
    const changes: FieldListChange[] = [
      { op: "add", label: "Plan", type: "select", options: ["Starter", "Pro"] },
      { op: "add", label: "Seats", type: "number" },
    ];
    let f = 0;
    for (const [i, change] of changes.entries()) {
      const r = await saveFieldListChange(ctx, "person", { baseRev: i, change, by: BY, nowIso: AT, newFieldId: () => `fld_${String((f += 1)).padStart(12, "0")}`, newOptionId: () => `opt_${String((o += 1)).padStart(8, "0")}` }, db);
      if (!r.ok) throw new Error(r.error);
    }
    db.seed("contacts", a.to, { tenantId: "ten_demo", contactKey: a.toKey, email: a.toKey, consentStatus: "none", campaigns: [], memberOf: ["all", "product:any", "product:pcn_1"], fields: a.theirs ?? {} });
    db.seed("contacts", a.from, { tenantId: "ten_demo", contactKey: a.fromKey, consentStatus: "none", campaigns: [], memberOf: [], fields: { [PLAN]: "opt_00000002", [SEATS]: 5 } });
    // Who set the old record's values, filed under it.
    await appendEvents(ctx, [fieldChangedEvent({ subject: { type: "person", id: a.from }, personId: a.from, fieldId: SEATS, object: "person", before: null, after: 5, source: "editor", actor: BY, at: AT, nonce: () => "set" })], { db });
    db.seed("person_moves", "mv_1", { tenantId: "ten_demo", productUserId: "pu_1", personId: a.to, fromPersonId: a.from, repoint: "pending", kind: a.kind, createdAt: new Date(T).toISOString() });
    db.seed("email_jobs", "pr_1", { tenantId: "ten_demo", type: "person_repoint", status: "processing", payload: { productUserId: "pu_1" } });
    const job = async () => (await forTenant(ctx, db).emailJobs.getById("pr_1")) as EmailJob;
    const fields = (id: string) => (db.raw("contacts", id) as { fields?: Record<string, unknown> } | undefined)?.fields;
    const fieldEvents = () => db.dump("ontology_events").filter((e) => e.kind === "record.field_changed" && e.tenantId === "ten_demo");
    return { db, job, fields, fieldEvents };
  }

  it("moves them on an address change, and the emptied record goes with its history", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(NEW)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect((w.db.raw("contacts", NEW) as { memberOf: string[] }).memberOf).toContain(`field:${PLAN}:opt_00000002`);
    // Nothing kept the old record but its values, so it went, and what was filed under it followed.
    expect(w.db.raw("contacts", FORMER)).toBeUndefined();
    expect(w.fieldEvents().every((e) => e.personId === NEW)).toBe(true);
    const moved = w.fieldEvents().filter((e) => (e.properties as { source: string }).source === "sync" && (e.properties as { before: unknown }).before === null);
    expect(moved.map((e) => e.fieldId).sort()).toEqual([PLAN, SEATS]);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("moves them when a pu: record merges into an address", async () => {
    const w = await valuesWorld({ kind: "record.merged", from: OLD as ContactPersonId, fromKey: "pu:pu_1", to: ADA, toKey: "ada@example.com" });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(ADA)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.db.raw("contacts", OLD)).toBeUndefined();
    expect(w.fieldEvents().filter((e) => e.personId === OLD)).toHaveLength(0);
  });

  it("keeps the new record's own value, and the old record stays holding the other", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com", theirs: { [PLAN]: "opt_00000001" } });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(NEW)).toEqual({ [PLAN]: "opt_00000001", [SEATS]: 5 });
    expect(w.fields(FORMER)).toEqual({ [PLAN]: "opt_00000002" });
    // The old record stays, so its own history stays with it.
    expect(w.fieldEvents().some((e) => e.personId === FORMER && (e.properties as { source: string }).source === "editor")).toBe(true);
  });

  it("moves nothing twice when the job is retried or put back in the queue", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com", theirs: { [PLAN]: "opt_00000001" } });
    let clock = T;
    // A slice that ends at once: the values move before the walk, then it asks to go again.
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => (clock += 30_000), sliceMs: 1 })).toBe("again");
    const once = { events: w.fieldEvents().length, now: w.fields(NEW), then: w.fields(FORMER) };
    expect(once.now).toEqual({ [PLAN]: "opt_00000001", [SEATS]: 5 });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fieldEvents()).toHaveLength(once.events);
    expect(w.fields(NEW)).toEqual(once.now);
    expect(w.fields(FORMER)).toEqual(once.then);
  });

  /** The next transaction fails, as Firestore's do under contention or past a deadline. */
  function failNextTransaction(db: FakeFirestore) {
    const real = db.runTransaction.bind(db);
    db.runTransaction = (async () => {
      db.runTransaction = real;
      throw Object.assign(new Error("ABORTED: transaction contention"), { code: 10 });
    }) as FakeFirestore["runTransaction"];
  }

  it("goes again with its moves pending when moving the values fails, and a later run moves them", async () => {
    const w = await valuesWorld({ kind: "record.merged", from: OLD as ContactPersonId, fromKey: "pu:pu_1", to: ADA, toKey: "ada@example.com" });
    failNextTransaction(w.db);
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("again");
    expect(w.fields(OLD)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.fields(ADA)).toEqual({});
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("pending");
    // The pu: record's history stays with the values it still holds.
    expect(w.fieldEvents().filter((e) => e.personId === OLD)).toHaveLength(1);
    // It picks up from the history stores: the five are done for this person.
    expect((await w.job()).payload).toMatchObject({ valueTries: 1, cursor: { store: HISTORY_STORES[0], after: null, target: ADA } });

    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T + 60_000 })).toBe("drop");
    expect(w.fields(ADA)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.db.raw("contacts", OLD)).toBeUndefined();
    expect(w.fieldEvents().filter((e) => e.personId === OLD)).toHaveLength(0);
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("makes the sync a product write couldn't, so a record left behind that still looks like someone in People gives up its values", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    // The write's sync failed: the old record is still in Everyone, flagged for the sweep.
    w.db.seed("contacts", FORMER, { ...w.db.raw("contacts", FORMER)!, memberOf: ["all", "product:any", "product:pcn_1"], needsSync: true });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(NEW)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.db.raw("contacts", FORMER)).toBeUndefined();
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("makes the sync a product write couldn't, so values reach a new record that wasn't there yet", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    w.db.cols.get("contacts")!.delete(NEW);
    // Enough of the product for a sync to build their link.
    w.db.seed("product_connections", "pcn_1", { ...w.db.raw("product_connections", "pcn_1")!, catalog: { onboardingSteps: [], events: [], facts: [], entityKinds: [] }, consentPolicy: { marketingBases: ["consent"] } });
    w.db.seed("product_users", "pu_1", { ...w.db.raw("product_users", "pu_1")!, email: "ada@new.example.com", firstSeenAt: AT });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(NEW)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect((w.db.raw("contacts", NEW) as { memberOf: string[] }).memberOf).toContain("all");
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("leaves the values with a record that is still someone in People, and settles its moves", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    w.db.seed("contacts", FORMER, { ...w.db.raw("contacts", FORMER)!, memberOf: ["all", "launch:any"] });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(FORMER)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.fields(NEW)).toEqual({});
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("settles its moves after its last try, leaving the values behind, so it never loops", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    await forTenant(ctx, w.db).emailJobs.update("pr_1", { payload: { productUserId: "pu_1", valueTries: MAX_VALUE_TRIES - 1 } });
    failNextTransaction(w.db);
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(FORMER)).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 5 });
    expect(w.db.raw("person_moves", "mv_1")?.repoint).toBe("done");
  });

  it("never touches another brand's records", async () => {
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    const theirs = personIdForAddress("ten_other", "ada@old.example.com")!;
    w.db.seed("contacts", theirs, { tenantId: "ten_other", contactKey: "ada@old.example.com", memberOf: [], fields: { [SEATS]: 9 } });
    expect(await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.fields(theirs)).toEqual({ [SEATS]: 9 });
    expect(w.db.dump("ontology_events").filter((e) => e.tenantId === "ten_other")).toHaveLength(0);
  });

  it("leaves nothing an erase can't reach: erasing the person takes every value and event", async () => {
    const { processContactEraseJob } = await import("@/lib/crm/eraseWorker");
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com" });
    await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T });
    expect(await processContactEraseJob(ctx, { id: "erase_ada", payload: { contactId: NEW } } as unknown as EmailJob, w.db)).toBe("done");
    expect(w.db.dump("contacts").filter((c) => c.tenantId === "ten_demo" && c.fields && Object.keys(c.fields as object).length)).toHaveLength(0);
    expect(w.db.dump("ontology_events").filter((e) => e.tenantId === "ten_demo" && (e.personId === NEW || e.personId === FORMER))).toHaveLength(0);
  });

  it("leaves nothing an erase can't reach when the old record stays: the product user's erase takes it", async () => {
    const { eraseProductUser } = await import("@/lib/connect/erase");
    const w = await valuesWorld({ kind: "record.repointed", from: FORMER, fromKey: "ada@old.example.com", to: NEW, toKey: "ada@new.example.com", theirs: { [PLAN]: "opt_00000001" } });
    await processPersonRepointJob(ctx, await w.job(), w.db, { now: () => T });
    expect(w.fields(FORMER)).toEqual({ [PLAN]: "opt_00000002" });
    await eraseProductUser(ctx, "pcn_1", "pu_1", w.db, T);
    expect(w.db.raw("contacts", FORMER)).toBeUndefined();
    expect(w.db.dump("ontology_events").filter((e) => e.tenantId === "ten_demo" && e.personId === FORMER)).toHaveLength(0);
  });
});
