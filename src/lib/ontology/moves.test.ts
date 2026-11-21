import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ProductUser } from "@/lib/types/productUser";
import { personIdOf } from "@/lib/audience/personSync";
import { processEmailJobs } from "@/lib/email/delivery";
import { moveId, ontologyAfterProductWrites, REPAIR_AFTER_MS, repairPendingMoves, repointJobKey } from "./moves";
import { personIdForAddress } from "./personRef";
import type { ContactPersonId } from "./person";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const CONNECTION = { id: "pcn_1", kind: "custom", status: "active" } as const;
const NOW = Date.parse("2026-11-20T10:00:00Z");

function user(over: Partial<ProductUser> = {}): ProductUser {
  return { id: "pu_1", connectionId: "pcn_1", emailNormalized: "ada@example.com", status: "active", ...over } as ProductUser;
}

describe("move and job ids", () => {
  it("one move id per write, stable for the same write", () => {
    expect(moveId("ten_demo", "v2:m1", "pu_1")).toBe(moveId("ten_demo", "v2:m1", "pu_1"));
    expect(moveId("ten_demo", "v2:m1", "pu_1")).toMatch(/^mv_[0-9a-f]{32}$/);
    expect(moveId("ten_demo", "v2:m2", "pu_1")).not.toBe(moveId("ten_demo", "v2:m1", "pu_1"));
    expect(moveId("ten_other", "v2:m1", "pu_1")).not.toBe(moveId("ten_demo", "v2:m1", "pu_1"));
  });

  it("one job key per product user and person they move to", () => {
    const a = personIdForAddress("ten_demo", "a@example.com")!;
    const b = personIdForAddress("ten_demo", "b@example.com")!;
    expect(repointJobKey("ten_demo", "pu_1", a)).toMatch(/^pr_[0-9a-f]{32}$/);
    expect(repointJobKey("ten_demo", "pu_1", a)).toBe(repointJobKey("ten_demo", "pu_1", a));
    expect(repointJobKey("ten_demo", "pu_1", b)).not.toBe(repointJobKey("ten_demo", "pu_1", a));
  });
});

describe("ontologyAfterProductWrites", () => {
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const PU_PERSON = personIdOf("ten_demo", "pu:pu_1") as ContactPersonId;
  const ADA = personIdForAddress("ten_demo", "ada@example.com")!;

  it("records a pu: person gaining an address as record.merged, pending, and queues the job", async () => {
    const db = new FakeFirestore();
    const r = await ontologyAfterProductWrites(ctx, CONNECTION, [{ user: user(), previousKey: "pu:pu_1", messageId: "v2:m1" }], { db, nowMs: NOW });
    expect(r).toEqual({ moves: 1, jobs: 1, failed: 0 });
    expect(db.raw("person_moves", moveId("ten_demo", "v2:m1", "pu_1"))).toMatchObject({
      tenantId: "ten_demo",
      kind: "record.merged",
      fromPersonId: PU_PERSON,
      personId: ADA,
      productUserId: "pu_1",
      connectionId: "pcn_1",
      repoint: "pending",
    });
    expect(db.raw("email_jobs", repointJobKey("ten_demo", "pu_1", ADA))).toMatchObject({ type: "person_repoint", status: "pending", campaignId: "", payload: { productUserId: "pu_1" } });
  });

  it("records an address that changed or went as record.repointed", async () => {
    const db = new FakeFirestore();
    await ontologyAfterProductWrites(
      ctx,
      CONNECTION,
      [
        { user: user({ emailNormalized: "new@example.com" }), previousKey: "ada@example.com", messageId: "v2:m1" },
        { user: user({ id: "pu_2", emailNormalized: null }), previousKey: "bea@example.com", messageId: "v2:m2" },
      ],
      { db, nowMs: NOW },
    );
    const moves = db.dump("person_moves");
    expect(moves.map((m) => m.kind)).toEqual(["record.repointed", "record.repointed"]);
    expect(moves[1]).toMatchObject({ personId: personIdOf("ten_demo", "pu:pu_2"), fromPersonId: personIdForAddress("ten_demo", "bea@example.com") });
  });

  it("keeps two moves for the same change made by two writes, and one for a write seen twice", async () => {
    const db = new FakeFirestore();
    const write = (messageId: string) => ({ user: user(), previousKey: "pu:pu_1", messageId });
    await ontologyAfterProductWrites(ctx, CONNECTION, [write("v2:m1"), write("v2:m2")], { db, nowMs: NOW });
    expect(db.dump("person_moves")).toHaveLength(2);
    // The same write again: its move and its job are already there.
    expect(await ontologyAfterProductWrites(ctx, CONNECTION, [write("v2:m1")], { db, nowMs: NOW })).toEqual({ moves: 0, jobs: 0, failed: 0 });
    expect(db.dump("person_moves")).toHaveLength(2);
    expect(db.dump("email_jobs")).toHaveLength(1);
  });

  it("records nothing when the person didn't change, for a first write, for a sandbox, or with the switch off", async () => {
    const db = new FakeFirestore();
    await ontologyAfterProductWrites(ctx, CONNECTION, [{ user: user(), previousKey: "ada@example.com", messageId: "a" }, { user: user(), previousKey: null, messageId: "b" }], { db, nowMs: NOW });
    await ontologyAfterProductWrites(ctx, { ...CONNECTION, kind: "sandbox" }, [{ user: user(), previousKey: "pu:pu_1", messageId: "c" }], { db, nowMs: NOW });
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    await ontologyAfterProductWrites(ctx, CONNECTION, [{ user: user(), previousKey: "pu:pu_1", messageId: "d" }], { db, nowMs: NOW });
    expect(db.dump("person_moves")).toHaveLength(0);
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("never throws, and never logs an address", async () => {
    const db = new FakeFirestore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(db, "collection").mockImplementation(() => {
      throw new Error("unavailable");
    });
    const r = await ontologyAfterProductWrites(ctx, CONNECTION, [{ user: user(), previousKey: "pu:pu_1", messageId: "v2:m1" }], { db, nowMs: NOW });
    expect(r.failed).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ada@example.com");
    warn.mockRestore();
  });
});

describe("repairPendingMoves", () => {
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const ADA = personIdForAddress("ten_demo", "ada@example.com")!;
  function seedMove(db: FakeFirestore, id: string, over: Record<string, unknown> = {}) {
    db.seed("person_moves", id, {
      tenantId: "ten_demo",
      kind: "record.merged",
      fromPersonId: personIdOf("ten_demo", "pu:pu_1"),
      personId: ADA,
      productUserId: "pu_1",
      connectionId: "pcn_1",
      at: new Date(NOW - REPAIR_AFTER_MS - 1).toISOString(),
      repoint: "pending",
      createdAt: new Date(NOW - REPAIR_AFTER_MS - 1).toISOString(),
      ...over,
    });
  }

  it("queues the job again only for moves pending longer than 15 minutes, in this brand", async () => {
    const db = new FakeFirestore();
    seedMove(db, "mv_old");
    seedMove(db, "mv_new", { productUserId: "pu_2", createdAt: new Date(NOW - 60_000).toISOString() });
    seedMove(db, "mv_done", { productUserId: "pu_3", repoint: "done" });
    seedMove(db, "mv_theirs", { tenantId: "ten_other", productUserId: "pu_4" });
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 1 });
    expect(db.dump("email_jobs")).toEqual([expect.objectContaining({ type: "person_repoint", payload: { productUserId: "pu_1" } })]);
    expect(db.raw("email_jobs", repointJobKey("ten_demo", "pu_1", ADA))).toBeDefined();
    expect(await repairPendingMoves(other, { db, now: NOW })).toEqual({ requeued: 1 });
  });

  it("dedupes by the job key: a job still queued is not queued twice", async () => {
    const db = new FakeFirestore();
    seedMove(db, "mv_a");
    seedMove(db, "mv_b");
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 1 });
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 0 });
    expect(db.dump("email_jobs")).toHaveLength(1);
  });

  it("does nothing while the switch is off", async () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    const db = new FakeFirestore();
    seedMove(db, "mv_old");
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 0 });
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("pages through pending moves, so ones whose jobs are still queued never hide one whose job was lost", async () => {
    const db = new FakeFirestore();
    // More than a page of moves whose jobs are still queued, all sorting before the lost one.
    for (let i = 10; i < 70; i += 1) {
      seedMove(db, `mv_a${i}`, { productUserId: `pu_q${i}` });
      db.seed("email_jobs", repointJobKey("ten_demo", `pu_q${i}`, ADA), { tenantId: "ten_demo", type: "person_repoint", status: "pending", payload: { productUserId: `pu_q${i}` } });
    }
    seedMove(db, "mv_z", { productUserId: "pu_lost" });
    expect(await repairPendingMoves(ctx, { db, now: NOW, pageSize: 25 })).toEqual({ requeued: 1 });
    expect(db.raw("email_jobs", repointJobKey("ten_demo", "pu_lost", ADA))).toMatchObject({ type: "person_repoint", payload: { productUserId: "pu_lost" } });
  });

  /** A product user with one move pending since before the repair window, as the tick finds them. */
  function stuck(connectionStatus: "active" | "revoked") {
    const db = new FakeFirestore();
    db.seed("product_connections", "pcn_1", { tenantId: "ten_demo", kind: "custom", status: connectionStatus });
    db.seed("product_users", "pu_1", { tenantId: "ten_demo", connectionId: "pcn_1", status: "active", emailNormalized: "ada@example.com" });
    seedMove(db, "mv_old");
    return db;
  }
  const drain = (db: FakeFirestore) => processEmailJobs(ctx, 10, db, { deadlineAt: Date.now() + 60_000 });

  it("stops queueing a move once its job finds the product revoked: the job marks it dropped", async () => {
    const db = stuck("revoked");
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 1 });
    await drain(db);
    expect(db.raw("person_moves", "mv_old")?.repoint).toBe("dropped");
    expect(db.dump("email_jobs")).toHaveLength(0);
    // The next ticks find nothing pending, so the job is never made again.
    for (let tick = 0; tick < 2; tick += 1) {
      expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 0 });
      await drain(db);
    }
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("queues a job again after it failed three times, and the move ends done", async () => {
    const db = stuck("active");
    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 1 });
    const read = db.collection.bind(db);
    const outage = vi.spyOn(db, "collection").mockImplementation((name: string) => {
      if (name === "product_users") throw new Error("unavailable");
      return read(name);
    });
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await drain(db)).toMatchObject({ failed: 1 });
    // Not parked as failed: its key would block the repair for good.
    expect(db.dump("email_jobs")).toHaveLength(0);
    expect(db.raw("person_moves", "mv_old")?.repoint).toBe("pending");
    outage.mockRestore();

    expect(await repairPendingMoves(ctx, { db, now: NOW })).toEqual({ requeued: 1 });
    expect(await drain(db)).toMatchObject({ done: 1, failed: 0 });
    expect(db.raw("person_moves", "mv_old")?.repoint).toBe("done");
    expect(db.dump("email_jobs")).toHaveLength(0);
  });
});
