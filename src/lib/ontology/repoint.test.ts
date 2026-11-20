import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { personIdOf } from "@/lib/audience/personSync";
import { personIdForAddress } from "./personRef";
import { processPersonRepointJob, REPOINT_STORES } from "./repoint";

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
  });

  it("never reaches another brand's product user", async () => {
    const w = world();
    expect(await processPersonRepointJob({ ...ctx, tenantId: "ten_other" }, await w.job(), w.db, { now: () => T })).toBe("drop");
    expect(w.db.raw("product_events", "product_events_theirs")?.personId).toBe(OLD);
    expect(w.people("product_events")).toEqual([OLD, OLD, OLD]);
  });
});
