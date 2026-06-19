import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { deleteLaunch } from "./launchDeletion";
import { TenantIsolationError } from "./errors";
import type { AuditObjectSink } from "./auditSink";
import type { TenantContext, FirestoreLike, CollectionLike } from "./types";

const ctxAdmin: TenantContext = {
  tenantId: "ten_A",
  region: "us",
  userId: "user_1",
  role: "admin",
  email: "admin@brand.com",
  source: "idtoken",
};

/** Captures every WORM write so tests can assert what would be persisted. */
class FakeAuditSink implements AuditObjectSink {
  readonly puts: { path: string; body: string }[] = [];
  async put(path: string, body: string): Promise<void> {
    this.puts.push({ path, body });
  }
}

function seedLaunch(db: FakeFirestore, tenantId: string, campaignId: string) {
  db.seed("campaigns", campaignId, { tenantId, waitlistName: "Camp One" });
  db.seed("signups", `${campaignId}-su1`, {
    tenantId,
    campaignId,
    email: "member@example.com",
    createdAt: "2026-06-15T16:00:00Z",
  });
  db.seed("signups", `${campaignId}-su2`, {
    tenantId,
    campaignId,
    email: "member2@example.com",
    createdAt: "2026-06-15T16:01:00Z",
  });
  db.seed("broadcasts", `${campaignId}-b1`, { tenantId, campaignId });
  db.seed("journeys", `${campaignId}-j1`, { tenantId, campaignId });
  db.seed("email_jobs", `${campaignId}-e1`, { tenantId, campaignId });
}

describe("deleteLaunch", () => {
  it("purges all of the launch's collections and leaves an audit trail", async () => {
    const db = new FakeFirestore();
    seedLaunch(db, "ten_A", "camp1");
    // Bystanders that MUST survive: another campaign, and another tenant.
    db.seed("signups", "other-su", {
      tenantId: "ten_A",
      campaignId: "camp2",
      email: "keep@example.com",
      createdAt: "2026-06-15T16:00:00Z",
    });
    db.seed("signups", "tenantB-su", {
      tenantId: "ten_B",
      campaignId: "camp1",
      email: "b@example.com",
      createdAt: "2026-06-15T16:00:00Z",
    });

    const sink = new FakeAuditSink();
    const result = await deleteLaunch(ctxAdmin, "camp1", { reason: "cleanup" }, db, sink);

    expect(result.deleted).toEqual({
      campaigns: 1,
      signups: 2,
      broadcasts: 1,
      journeys: 1,
      emailJobs: 1,
    });
    expect(result.auditComplete).toBe(true); // WORM outcome record persisted

    // Two immutable WORM objects: an "initiated" intent record (written before
    // the purge, zero counts) then the "completed" outcome (final counts).
    expect(sink.puts).toHaveLength(2);
    expect(sink.puts[0]!.path).toMatch(
      /^audit\/launch-delete\/ten_A_camp1_.+_initiated\.json$/,
    );
    expect(sink.puts[1]!.path).toMatch(
      /^audit\/launch-delete\/ten_A_camp1_.+_completed\.json$/,
    );
    const initiated = JSON.parse(sink.puts[0]!.body);
    const completed = JSON.parse(sink.puts[1]!.body);
    expect(initiated.status).toBe("initiated");
    expect(initiated.deleted).toEqual({
      campaigns: 0, signups: 0, broadcasts: 0, journeys: 0, emailJobs: 0,
    });
    expect(completed.status).toBe("completed");
    expect(completed.deleted).toEqual({
      campaigns: 1, signups: 2, broadcasts: 1, journeys: 1, emailJobs: 1,
    });
    // The WORM body is PII-free too — operator identity yes, member PII never.
    for (const { body } of sink.puts) {
      expect(body).toContain("admin@brand.com");
      expect(body).not.toContain("member@example.com");
      expect(body).not.toContain("member2@example.com");
    }

    // Everything for camp1 in ten_A is gone.
    expect(db.raw("campaigns", "camp1")).toBeUndefined();
    expect(db.raw("signups", "camp1-su1")).toBeUndefined();
    expect(db.raw("signups", "camp1-su2")).toBeUndefined();
    expect(db.raw("broadcasts", "camp1-b1")).toBeUndefined();
    expect(db.raw("journeys", "camp1-j1")).toBeUndefined();
    expect(db.raw("email_jobs", "camp1-e1")).toBeUndefined();

    // Bystanders untouched.
    expect(db.raw("signups", "other-su")).toBeDefined();
    expect(db.raw("signups", "tenantB-su")).toBeDefined();

    // Exactly one immutable audit row, recording who/when/what/how-many.
    const audit = db.dump("audit_events");
    expect(audit).toHaveLength(1);
    const row = audit[0]!;
    expect(row).toMatchObject({
      action: "launch.delete",
      status: "completed",
      actorUid: "user_1",
      actorEmail: "admin@brand.com",
      actorRole: "admin",
      tenantId: "ten_A",
      region: "us",
      campaignId: "camp1",
      campaignName: "Camp One",
      reason: "cleanup",
      deleted: { campaigns: 1, signups: 2, broadcasts: 1, journeys: 1, emailJobs: 1 },
    });
    expect(typeof row.createdAt).toBe("string");

    // SOC 2 / GDPR: the audit row records counts + the OPERATOR's identity, but
    // never the erased waitlist-member PII.
    const serialized = JSON.stringify(row);
    expect(serialized).toContain("admin@brand.com");
    expect(serialized).not.toContain("member@example.com");
    expect(serialized).not.toContain("member2@example.com");
  });

  it("refuses to delete a launch in another tenant and writes no audit row", async () => {
    const db = new FakeFirestore();
    seedLaunch(db, "ten_B", "camp_b");

    await expect(deleteLaunch(ctxAdmin, "camp_b", {}, db)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );

    // Foreign launch fully intact; nothing logged for a non-event.
    expect(db.raw("campaigns", "camp_b")).toBeDefined();
    expect(db.raw("signups", "camp_b-su1")).toBeDefined();
    expect(db.dump("audit_events")).toHaveLength(0);
  });

  it("ABORTS the purge if the immutable intent record can't be written", async () => {
    const db = new FakeFirestore();
    seedLaunch(db, "ten_A", "camp1");
    // WORM store is down → the "initiated" write throws before any delete.
    const downSink: AuditObjectSink = {
      put: async () => {
        throw new Error("worm store unavailable");
      },
    };

    await expect(
      deleteLaunch(ctxAdmin, "camp1", {}, db, downSink),
    ).rejects.toThrow(/worm store unavailable/);

    // No data was purged without a durable trail, and no outcome was recorded.
    expect(db.raw("campaigns", "camp1")).toBeDefined();
    expect(db.raw("signups", "camp1-su1")).toBeDefined();
    expect(db.raw("broadcasts", "camp1-b1")).toBeDefined();
    expect(db.dump("audit_events")).toHaveLength(0);
  });

  it("does NOT fail the deletion if only the OUTCOME WORM write fails (data already purged)", async () => {
    const db = new FakeFirestore();
    seedLaunch(db, "ten_A", "camp1");
    // Intent record succeeds; every outcome write attempt fails. The purge has
    // happened by then, so the call must still resolve (the failure is logged, not
    // thrown) and the Firestore index copy is still written.
    let call = 0;
    const flakySink: AuditObjectSink = {
      put: async () => {
        call += 1;
        if (call === 1) return; // "initiated" succeeds
        throw new Error("worm outcome write failed");
      },
    };

    const result = await deleteLaunch(ctxAdmin, "camp1", {}, db, flakySink);

    expect(result.deleted.campaigns).toBe(1);
    // The purge completed but the authoritative WORM outcome record did not —
    // the caller is told (not a silent 200) so it can reconcile.
    expect(result.auditComplete).toBe(false);
    expect(db.raw("campaigns", "camp1")).toBeUndefined(); // purge completed
    // Firestore index still carries the completed outcome row.
    const audit = db.dump("audit_events");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: "completed" });
  });

  it("records a 'failed' audit row (with partial counts) and rethrows when a purge step fails", async () => {
    const real = new FakeFirestore();
    seedLaunch(real, "ten_A", "camp1");
    // Wrap so deleting the CAMPAIGN doc (the last step) throws — children already
    // purged, so the failed row should carry their counts and campaigns: 0.
    const db = dbThatFailsDeletingFrom(real, "campaigns");

    await expect(deleteLaunch(ctxAdmin, "camp1", { reason: "oops" }, db)).rejects.toThrow(
      /forced delete failure/,
    );

    // Children were purged before the failure...
    expect(real.raw("signups", "camp1-su1")).toBeUndefined();
    expect(real.raw("broadcasts", "camp1-b1")).toBeUndefined();
    // ...but the campaign doc survives (delete threw), so the launch is still visible.
    expect(real.raw("campaigns", "camp1")).toBeDefined();

    const audit = real.dump("audit_events");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "launch.delete",
      status: "failed",
      campaignId: "camp1",
      reason: "oops",
      deleted: { campaigns: 0, signups: 2, broadcasts: 1, journeys: 1, emailJobs: 1 },
      errorCode: "PERMISSION_DENIED", // structured code captured for forensic triage
    });
    expect(String(audit[0]!.error)).toMatch(/forced delete failure/);
  });
});

/**
 * A FirestoreLike that delegates to `real` but makes `delete()` on the target
 * collection throw — to exercise deleteLaunch's failure/audit path without a real
 * database. Reads + writes to every other collection (incl. `audit_events`) pass
 * straight through to the underlying fake.
 */
function dbThatFailsDeletingFrom(
  real: FakeFirestore,
  target: string,
): FirestoreLike {
  return {
    collection(name: string): CollectionLike {
      const col = real.collection(name);
      if (name !== target) return col;
      return {
        where: (...a) => col.where(...a),
        orderBy: (...a) => col.orderBy(...a),
        limit: (n) => col.limit(n),
        get: () => col.get(),
        count: () => col.count(),
        doc: (id?: string) => {
          const ref = col.doc(id);
          return {
            id: ref.id,
            get: () => ref.get(),
            create: (d) => ref.create(d),
            set: (d) => ref.set(d),
            update: (d) => ref.update(d),
            delete: async () => {
              // Carry a structured code, like a real Firestore gRPC error, so the
              // audit row's errorCode capture is exercised.
              throw Object.assign(new Error(`forced delete failure in ${target}`), {
                code: "PERMISSION_DENIED",
              });
            },
          };
        },
      };
    },
  };
}
