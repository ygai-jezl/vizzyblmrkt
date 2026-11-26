import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { isNotFound } from "./firestore";
import type { TenantContext } from "./types";

const ctxA: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

function signup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: "camp1",
    email: "x@example.com",
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "TOK",
    referralLink: "https://x/?ref=TOK",
    score: 0,
    createdAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

describe("TenantCollection isolation", () => {
  it("stamps the trusted tenantId on create and ignores caller-supplied tenantId/id", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    // Attacker tries to smuggle a foreign tenantId + id into the payload.
    await repo.signups.create("s1", {
      ...signup(),
      tenantId: "ten_EVIL",
      id: "evil_id",
    } as never);

    const raw = db.raw("signups", "s1")!;
    expect(raw.tenantId).toBe("ten_A");
    expect(db.raw("signups", "evil_id")).toBeUndefined();
  });

  it("create() refuses to overwrite an existing id belonging to another tenant", async () => {
    const db = new FakeFirestore();
    // Tenant B owns a campaign with a guessable slug id.
    db.seed("campaigns", "beta-launch", {
      tenantId: "ten_B",
      waitlistName: "B's campaign",
    });

    // Tenant A tries to hijack/destroy it by creating the same id.
    await expect(
      forTenant(ctxA, db).campaigns.create("beta-launch", {
        waitlistName: "A's campaign",
      } as never),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    // Tenant B's document is untouched.
    const raw = db.raw("campaigns", "beta-launch")!;
    expect(raw.tenantId).toBe("ten_B");
    expect(raw.waitlistName).toBe("B's campaign");
  });

  it("create() refuses to overwrite an id within the same tenant (no silent clobber)", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);
    await expect(repo.signups.create("s1", signup() as never)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it("find() is always scoped to the context tenant", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    const got = await forTenant(ctxA, db).signups.find();
    expect(got.map((s) => s.id)).toEqual(["s1"]);
  });

  it("a caller cannot widen the result set by overriding the tenant filter", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    // Malicious attempt to read tenant B's data from tenant A's context.
    const got = await forTenant(ctxA, db).signups.find({
      where: [["tenantId", "==", "ten_B"]],
    });
    expect(got.map((s) => s.id)).toEqual(["s1"]); // override ignored; still A-only
  });

  it("getById() returns null for a document belonging to another tenant", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    // THE cross-tenant negative test: A guesses B's document id.
    expect(await forTenant(ctxA, db).signups.getById("s2")).toBeNull();
    // B can read its own document.
    expect((await forTenant(ctxB, db).signups.getById("s2"))?.id).toBe("s2");
  });

  it("count() is tenant-scoped", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));
    db.seed("signups", "s3", signup({ tenantId: "ten_A" }));

    expect(await forTenant(ctxA, db).signups.count()).toBe(2);
    expect(await forTenant(ctxB, db).signups.count()).toBe(1);
  });

  it("refuses cross-tenant update/delete and leaves the foreign doc intact", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s2", signup({ tenantId: "ten_B", isSpam: false }));
    const repoA = forTenant(ctxA, db);

    await expect(repoA.signups.update("s2", { isSpam: true })).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(repoA.signups.delete("s2")).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    expect(db.raw("signups", "s2")!.isSpam).toBe(false);
    expect(db.raw("signups", "s2")).toBeDefined();
  });

  it("allows update/delete within the same tenant", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);

    await repo.signups.update("s1", { isSpam: true });
    expect(db.raw("signups", "s1")!.isSpam).toBe(true);

    await repo.signups.delete("s1");
    expect(db.raw("signups", "s1")).toBeUndefined();
  });

  it("update() ignores attempts to change immutable identity fields (tenantId/id/createdAt)", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup({ createdAt: "2026-06-15T16:00:00Z" }) as never);

    await repo.signups.update("s1", {
      isSpam: true,
      tenantId: "ten_EVIL",
      id: "evil",
      createdAt: "2099-01-01T00:00:00Z",
    } as never);

    const raw = db.raw("signups", "s1")!;
    expect(raw.isSpam).toBe(true); // mutable field updated
    expect(raw.tenantId).toBe("ten_A"); // tenant never re-homed
    expect(raw.createdAt).toBe("2026-06-15T16:00:00Z"); // createdAt immutable
    expect(db.raw("signups", "evil")).toBeUndefined(); // id never changed
  });

  it("deleteWhere() removes only this tenant's matching docs and returns the count", async () => {
    const db = new FakeFirestore();
    // Tenant A: two signups in camp1, one in camp2.
    db.seed("signups", "a1", signup({ tenantId: "ten_A", campaignId: "camp1" }));
    db.seed("signups", "a2", signup({ tenantId: "ten_A", campaignId: "camp1" }));
    db.seed("signups", "a3", signup({ tenantId: "ten_A", campaignId: "camp2" }));
    // Tenant B has a signup in camp1 too — must NOT be touched.
    db.seed("signups", "b1", signup({ tenantId: "ten_B", campaignId: "camp1" }));

    const removed = await forTenant(ctxA, db).signups.deleteWhere([
      ["campaignId", "==", "camp1"],
    ]);

    expect(removed).toBe(2);
    expect(db.raw("signups", "a1")).toBeUndefined();
    expect(db.raw("signups", "a2")).toBeUndefined();
    expect(db.raw("signups", "a3")).toBeDefined(); // other campaign untouched
    expect(db.raw("signups", "b1")).toBeDefined(); // other tenant untouched
  });

  it("deleteWhere() pages through more docs than the page size", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 7; i += 1) {
      db.seed("signups", `s${i}`, signup({ tenantId: "ten_A", campaignId: "camp1" }));
    }
    const removed = await forTenant(ctxA, db).signups.deleteWhere(
      [["campaignId", "==", "camp1"]],
      { pageSize: 2 },
    );
    expect(removed).toBe(7);
    expect(await forTenant(ctxA, db).signups.count()).toBe(0);
  });

  it("deleteWhere() cannot be widened past the tenant predicate", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "b1", signup({ tenantId: "ten_B" }));

    // Malicious attempt to also purge tenant B by re-filtering the tenant field.
    const removed = await forTenant(ctxA, db).signups.deleteWhere([
      ["tenantId", "==", "ten_B"],
    ]);

    expect(removed).toBe(1); // only A's own doc
    expect(db.raw("signups", "a1")).toBeUndefined();
    expect(db.raw("signups", "b1")).toBeDefined();
  });

  it("forTenant() rejects a context without a tenantId", () => {
    const db = new FakeFirestore();
    expect(() =>
      forTenant({ tenantId: "", region: "us", source: "system" }, db),
    ).toThrow(TenantValidationError);
  });

  it("forTenant() rejects a context without a region (residency guardrail)", () => {
    const db = new FakeFirestore();
    expect(() =>
      // region intentionally omitted — must throw, never silently default.
      forTenant({ tenantId: "ten_A", source: "system" } as never, db),
    ).toThrow(TenantValidationError);
  });
});

describe("TenantCollection.upsert (atomic create-or-update)", () => {
  it("creates when the id is free, stamping the trusted tenant", async () => {
    const db = new FakeFirestore();
    const r = await forTenant(ctxA, db).signups.upsert(
      "s1",
      () => ({ ...signup(), tenantId: "ten_EVIL" }) as never,
      () => {
        throw new Error("mutate must not run on create");
      },
    );
    expect(r.created).toBe(true);
    expect(db.raw("signups", "s1")).toMatchObject({ tenantId: "ten_A", email: "x@example.com" });
  });

  it("updates in place within the same tenant and never rewrites createdAt", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);

    const r = await repo.signups.upsert(
      "s1",
      () => {
        throw new Error("create must not run on update");
      },
      (cur) => ({ score: (cur.score ?? 0) + 5, createdAt: "2099-01-01T00:00:00Z" }) as never,
    );
    expect(r.created).toBe(false);
    expect(r.doc.score).toBe(5);
    expect(db.raw("signups", "s1")).toMatchObject({ score: 5, createdAt: "2026-06-15T16:00:00Z" });
  });

  it("leaves the document unchanged when mutate returns null", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);
    const before = db.writeCountFor("signups", "s1");

    await repo.signups.upsert("s1", () => signup() as never, () => null);

    expect(db.writeCountFor("signups", "s1")).toBe(before);
  });

  it("refuses an id that belongs to another tenant, leaving it intact", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", { ...signup(), tenantId: "ten_B" });

    await expect(
      forTenant(ctxA, db).signups.upsert("s1", () => signup() as never, () => ({ score: 9 }) as never),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    expect(db.raw("signups", "s1")).toMatchObject({ tenantId: "ten_B", score: 0 });
  });

  it("takes the update path when a concurrent writer creates the doc first", async () => {
    const db = new FakeFirestore();
    db.onBeforeCommit = async () => {
      await db.collection("signups").doc("s1").create({ ...signup(), tenantId: "ten_A", score: 1 });
    };

    const r = await forTenant(ctxA, db).signups.upsert(
      "s1",
      () => signup() as never,
      (cur) => ({ score: (cur.score ?? 0) + 1 }) as never,
    );

    expect(r.created).toBe(false);
    expect(db.raw("signups", "s1")).toMatchObject({ score: 2 });
  });

  it("rejects an empty id", async () => {
    const db = new FakeFirestore();
    await expect(
      forTenant(ctxA, db).signups.upsert("", () => signup() as never, () => null),
    ).rejects.toBeInstanceOf(TenantValidationError);
  });
});

describe("TenantCollection.updateWhere (a paged update by query)", () => {
  /** Walk every page, as the repoint job and the backfill do. */
  async function walk(
    db: FakeFirestore,
    ctx: TenantContext,
    where: Array<[string, "==", unknown]>,
    plan: (row: Record<string, unknown>) => Record<string, unknown> | null,
    opts: { limit: number; dryRun?: boolean },
  ) {
    const totals = { pages: 0, scanned: 0, updated: 0, unchanged: 0, gone: 0 };
    let after: string | null = null;
    for (;;) {
      const r = await forTenant(ctx, db).signups.updateWhere(where as never, plan as never, { ...opts, startAfter: after });
      totals.pages += 1;
      totals.scanned += r.scanned;
      totals.updated += r.updated;
      totals.unchanged += r.unchanged;
      totals.gone += r.gone;
      after = r.last;
      if (!r.more) return totals;
    }
  }

  it("never reads or writes another tenant's rows", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "b1", signup({ tenantId: "ten_B" }));
    const seen: string[] = [];
    const t = await walk(db, ctxA, [], (row) => {
      seen.push(String(row.id));
      return { score: 9 };
    }, { limit: 10 });
    expect(seen).toEqual(["a1"]);
    expect(t.updated).toBe(1);
    expect(db.raw("signups", "a1")).toMatchObject({ score: 9 });
    expect(db.raw("signups", "b1")).toMatchObject({ score: 0 });
    expect(db.writeCountFor("signups", "b1")).toBe(0);
  });

  it("drops a tenantId clause instead of widening the query", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "b1", signup({ tenantId: "ten_B" }));
    const t = await walk(db, ctxA, [["tenantId", "==", "ten_B"]], () => ({ score: 9 }), { limit: 10 });
    expect(t.scanned).toBe(1);
    expect(db.raw("signups", "a1")).toMatchObject({ score: 9 });
    expect(db.raw("signups", "b1")).toMatchObject({ score: 0 });
  });

  it("keeps to the where clause", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A", campaignId: "camp1" }));
    db.seed("signups", "a2", signup({ tenantId: "ten_A", campaignId: "camp2" }));
    await walk(db, ctxA, [["campaignId", "==", "camp1"]], () => ({ score: 9 }), { limit: 10 });
    expect(db.raw("signups", "a1")).toMatchObject({ score: 9 });
    expect(db.raw("signups", "a2")).toMatchObject({ score: 0 });
  });

  it("strips tenantId, id and createdAt from every patch", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "a2", signup({ tenantId: "ten_A" }));
    const t = await walk(
      db,
      ctxA,
      [],
      (row) => (row.id === "a1" ? { tenantId: "ten_B", id: "evil", createdAt: "1999-01-01", score: 5 } : { tenantId: "ten_B" }),
      { limit: 10 },
    );
    expect(db.raw("signups", "a1")).toMatchObject({ tenantId: "ten_A", createdAt: "2026-06-15T16:00:00Z", score: 5 });
    expect(db.raw("signups", "evil")).toBeUndefined();
    // A patch of identity fields only is nothing to write.
    expect(t).toMatchObject({ updated: 1, unchanged: 1 });
    expect(db.writeCountFor("signups", "a2")).toBe(0);
  });

  it("counts a row deleted between the read and the write as gone, and never creates it again", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "a2", signup({ tenantId: "ten_A" }));
    const r = await forTenant(ctxA, db).signups.updateWhere(
      [],
      (row) => {
        // A time to live or an erase takes a2 while the page is being planned.
        if (row.id === "a1") db.cols.get("signups")!.delete("a2");
        return { score: 7 };
      },
      { limit: 10 },
    );
    expect(r).toMatchObject({ scanned: 2, updated: 1, gone: 1, unchanged: 0 });
    expect(db.raw("signups", "a1")).toMatchObject({ score: 7 });
    expect(db.raw("signups", "a2")).toBeUndefined();
  });

  it("pages across a boundary by document id, each row once", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 7; i += 1) db.seed("signups", `a${i}`, signup({ tenantId: "ten_A" }));
    db.seed("signups", "b0", signup({ tenantId: "ten_B" }));
    const seen: string[] = [];
    const t = await walk(db, ctxA, [], (row) => {
      seen.push(String(row.id));
      return Number(String(row.id).slice(1)) % 2 === 0 ? { score: 1 } : null;
    }, { limit: 3 });
    expect(seen).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "a6"]);
    expect(t).toMatchObject({ pages: 3, scanned: 7, updated: 4, unchanged: 3, gone: 0 });
  });

  it("returns the cursor it was given when a page is empty", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    const r = await forTenant(ctxA, db).signups.updateWhere([], () => ({ score: 1 }), { startAfter: "a1", limit: 5 });
    expect(r).toEqual({ scanned: 0, updated: 0, unchanged: 0, gone: 0, last: "a1", more: false });
  });

  it("writes nothing in a dry run, and counts what it would write", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 4; i += 1) db.seed("signups", `a${i}`, signup({ tenantId: "ten_A" }));
    const t = await walk(db, ctxA, [], (row) => (row.id === "a0" ? null : { score: 3 }), { limit: 2, dryRun: true });
    expect(t).toMatchObject({ scanned: 4, updated: 3, unchanged: 1 });
    for (let i = 0; i < 4; i += 1) {
      expect(db.raw("signups", `a${i}`)).toMatchObject({ score: 0 });
      expect(db.writeCountFor("signups", `a${i}`)).toBe(0);
    }
  });

  it("takes an async plan", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a1", signup({ tenantId: "ten_A" }));
    const r = await forTenant(ctxA, db).signups.updateWhere([], async () => ({ score: 4 }), { limit: 5 });
    expect(r.updated).toBe(1);
    expect(db.raw("signups", "a1")).toMatchObject({ score: 4 });
  });
});

describe("the fake's update() of a missing document", () => {
  it("fails with NOT_FOUND, as Firestore does, and creates nothing", async () => {
    const db = new FakeFirestore();
    const err = await db.collection("signups").doc("nope").update({ score: 1 }).catch((e: unknown) => e);
    expect(isNotFound(err)).toBe(true);
    expect(isNotFound(new Error("other"))).toBe(false);
    expect(isNotFound({ code: "not-found" })).toBe(true);
    expect(isNotFound({ code: "NOT_FOUND" })).toBe(true);
    expect(db.raw("signups", "nope")).toBeUndefined();
  });
});

describe("find by a field inside a map", () => {
  it("reads a dotted name as a path, as Firestore does, and stays in the tenant", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "product-updates", { tenantId: "ten_A", idea: { justAList: true } });
    db.seed("campaigns", "team-spaces", { tenantId: "ten_A", idea: { status: "testing" } });
    db.seed("campaigns", "old-launch", { tenantId: "ten_A" });
    db.seed("campaigns", "their-list", { tenantId: "ten_B", idea: { justAList: true } });
    const lists = await forTenant(ctxA, db).campaigns.find({ where: [["idea.justAList", "==", true]] });
    expect(lists.map((c) => c.id)).toEqual(["product-updates"]);
  });
});

describe("TenantCollection.increment (counters with no read)", () => {
  it("takes an id that holds the tenant's id whole, between underscores or between colons", async () => {
    const db = new FakeFirestore();
    await forTenant(ctxA, db).usageMeters.increment("um_ten_A_2026-11", { meters: { images: { total: 1 } } });
    await forTenant(ctxA, db).loopDays.increment("lw:ten_A:2026-W48:0", { d: { t: { image_asset: { made: 1 } } } });
    expect(db.raw("loop_days", "lw:ten_A:2026-W48:0")).toEqual({ tenantId: "ten_A", d: { t: { image_asset: { made: 1 } } } });
  });

  it("refuses an id that names another tenant, or a longer id that starts with this one", async () => {
    const db = new FakeFirestore();
    for (const id of ["lw:ten_B:2026-W48:0", "lw:ten_AB:2026-W48:0", "lw:ten_A", "ten_A"]) {
      await expect(forTenant(ctxA, db).loopDays.increment(id, { d: { x: 1 } }), id).rejects.toBeInstanceOf(TenantValidationError);
    }
    expect(db.dump("loop_days")).toEqual([]);
  });
});

describe("TenantCollection.findFields (a projected find)", () => {
  it("reads only the named fields of this brand's rows, in order", async () => {
    const db = new FakeFirestore();
    await forTenant(ctxA, db).signups.create("s1", signup({ score: 3, createdAt: "2026-06-15T16:00:00Z" }) as never);
    await forTenant(ctxA, db).signups.create("s2", signup({ score: 5, createdAt: "2026-06-16T16:00:00Z" }) as never);
    await forTenant(ctxB, db).signups.create("s3", signup({ score: 9 }) as never);
    const rows = await forTenant(ctxA, db).signups.findFields(["score", "createdAt"], { orderBy: [["createdAt", "desc"]], limit: 5 });
    expect(rows).toEqual([
      { id: "s2", score: 5, createdAt: "2026-06-16T16:00:00Z" },
      { id: "s1", score: 3, createdAt: "2026-06-15T16:00:00Z" },
    ]);
  });

  it("never widens past the brand, whatever the where clause says", async () => {
    const db = new FakeFirestore();
    await forTenant(ctxB, db).signups.create("s3", signup() as never);
    expect(await forTenant(ctxA, db).signups.findFields(["score"], { where: [["tenantId", "==", "ten_B"]] })).toEqual([]);
  });
});

describe("find with a projection (select)", () => {
  it("returns only the named fields, a dotted one as a path into its map, with the id, and stays in the tenant", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", {
      tenantId: "ten_A",
      sortKey: "2026-11-25T10:00:00.000Z|ct_1",
      memberOf: ["all"],
      email: "kept-out@example.com",
      fields: { fld_aaaaaaaaaaaa: "opt_aaaaaaaa", fld_bbbbbbbbbbbb: "not asked for" },
    });
    db.seed("contacts", "ct_2", { tenantId: "ten_A", sortKey: "2026-11-24T10:00:00.000Z|ct_2", memberOf: ["all"] });
    db.seed("contacts", "ct_3", { tenantId: "ten_B", sortKey: "2026-11-26T10:00:00.000Z|ct_3", memberOf: ["all"], fields: { fld_aaaaaaaaaaaa: "theirs" } });
    const rows = await forTenant(ctxA, db).contacts.find({
      where: [["memberOf", "array-contains", "all"]],
      orderBy: [["sortKey", "desc"]],
      select: ["sortKey", "memberOf", "fields.fld_aaaaaaaaaaaa"],
    });
    expect(rows).toEqual([
      { id: "ct_1", sortKey: "2026-11-25T10:00:00.000Z|ct_1", memberOf: ["all"], fields: { fld_aaaaaaaaaaaa: "opt_aaaaaaaa" } },
      { id: "ct_2", sortKey: "2026-11-24T10:00:00.000Z|ct_2", memberOf: ["all"] },
    ]);
  });

  it("refuses a projection a database can't read, rather than reading every field", async () => {
    // A database whose queries have no select(), as some test doubles don't.
    const query: Record<string, unknown> = {
      get: async () => ({ empty: true, size: 0, docs: [] }),
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    };
    for (const k of ["where", "orderBy", "limit", "startAfter"]) query[k] = () => query;
    const plain = { collection: () => ({ ...query, doc: () => null }), runTransaction: async () => null } as unknown as FakeFirestore;
    await expect(forTenant(ctxA, plain).contacts.find({ select: ["memberOf"] })).rejects.toThrow(TenantValidationError);
    await expect(forTenant(ctxA, plain).contacts.find({})).resolves.toEqual([]);
  });
});
