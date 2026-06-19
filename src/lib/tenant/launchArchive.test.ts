import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { setLaunchArchived } from "./launchArchive";
import { TenantIsolationError } from "./errors";
import type { AuditObjectSink } from "./auditSink";
import type { TenantContext } from "./types";

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

function seedCampaign(
  db: FakeFirestore,
  tenantId: string,
  campaignId: string,
  extra: Record<string, unknown> = {},
) {
  db.seed("campaigns", campaignId, {
    tenantId,
    waitlistName: "Camp One",
    createdAt: "2026-06-15T16:00:00Z",
    ...extra,
  });
}

function seedJourney(
  db: FakeFirestore,
  tenantId: string,
  campaignId: string,
  status: "draft" | "active" | "paused",
) {
  db.seed("journeys", `journey_${campaignId}`, {
    tenantId,
    campaignId,
    status,
    graph: { nodes: [], edges: [] },
    createdAt: "2026-06-15T16:00:00Z",
    updatedAt: "2026-06-15T16:00:00Z",
  });
}

describe("setLaunchArchived", () => {
  it("archives a launch: sets archivedAt, pauses the active journey, and records a PII-free audit row", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1");
    seedJourney(db, "ten_A", "camp1", "active");
    // A member whose PII must never reach the audit trail.
    db.seed("signups", "camp1-su1", {
      tenantId: "ten_A",
      campaignId: "camp1",
      email: "member@example.com",
      createdAt: "2026-06-15T16:00:00Z",
    });

    const sink = new FakeAuditSink();
    const result = await setLaunchArchived(
      ctxAdmin,
      "camp1",
      "archive",
      { reason: "wrapped up" },
      db,
      sink,
    );

    expect(typeof result.archivedAt).toBe("string");
    expect(result.journeyPaused).toBe(true);
    expect(result.auditPersisted).toBe(true);

    // The launch is now archived and its active journey was paused.
    expect(typeof db.raw("campaigns", "camp1")!.archivedAt).toBe("string");
    expect(db.raw("journeys", "journey_camp1")!.status).toBe("paused");

    // One immutable WORM object under the launch-archive prefix.
    expect(sink.puts).toHaveLength(1);
    expect(sink.puts[0]!.path).toMatch(
      /^audit\/launch-archive\/ten_A_camp1_.+_recorded\.json$/,
    );

    // Exactly one Firestore index row, recording who/when/what — never member PII.
    const audit = db.dump("audit_events");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "launch.archive",
      status: "recorded",
      actorUid: "user_1",
      actorEmail: "admin@brand.com",
      actorRole: "admin",
      tenantId: "ten_A",
      region: "us",
      campaignId: "camp1",
      campaignName: "Camp One",
      reason: "wrapped up",
    });
    expect(audit[0]!.deleted).toBeUndefined(); // no purge counts on archive
    const serialized = JSON.stringify(audit[0]) + sink.puts[0]!.body;
    expect(serialized).toContain("admin@brand.com");
    expect(serialized).not.toContain("member@example.com");
  });

  it("does not touch a draft/paused journey when archiving", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1");
    seedJourney(db, "ten_A", "camp1", "draft");

    const result = await setLaunchArchived(ctxAdmin, "camp1", "archive", {}, db, new FakeAuditSink());

    expect(result.journeyPaused).toBe(false);
    expect(db.raw("journeys", "journey_camp1")!.status).toBe("draft");
    expect(typeof db.raw("campaigns", "camp1")!.archivedAt).toBe("string");
  });

  it("archives a launch with no journey doc without throwing", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1");

    const result = await setLaunchArchived(ctxAdmin, "camp1", "archive", {}, db, new FakeAuditSink());

    expect(result.journeyPaused).toBe(false);
    expect(typeof db.raw("campaigns", "camp1")!.archivedAt).toBe("string");
  });

  it("restores a launch: clears archivedAt (null) and leaves the paused journey paused", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1", { archivedAt: "2026-06-18T10:00:00Z" });
    seedJourney(db, "ten_A", "camp1", "paused");

    const sink = new FakeAuditSink();
    const result = await setLaunchArchived(ctxAdmin, "camp1", "restore", {}, db, sink);

    expect(result.archivedAt).toBeNull();
    // Cleared with null (NOT undefined — which the fake/Firestore would drop).
    expect(db.raw("campaigns", "camp1")!.archivedAt).toBeNull();
    // Restore must NOT auto-resume the journey.
    expect(db.raw("journeys", "journey_camp1")!.status).toBe("paused");

    expect(sink.puts).toHaveLength(1);
    expect(sink.puts[0]!.path).toMatch(
      /^audit\/launch-restore\/ten_A_camp1_.+_recorded\.json$/,
    );
    const audit = db.dump("audit_events");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "launch.restore", status: "recorded" });
  });

  it("refuses to archive a launch in another tenant and writes no audit row", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_B", "camp_b");

    await expect(
      setLaunchArchived(ctxAdmin, "camp_b", "archive", {}, db),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    expect(db.raw("campaigns", "camp_b")!.archivedAt).toBeUndefined();
    expect(db.dump("audit_events")).toHaveLength(0);
  });

  it("is idempotent: re-archiving an archived launch is a no-op (no second audit row)", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1", { archivedAt: "2026-06-18T10:00:00Z" });
    seedJourney(db, "ten_A", "camp1", "active");

    const sink = new FakeAuditSink();
    const result = await setLaunchArchived(ctxAdmin, "camp1", "archive", {}, db, sink);

    expect(result.archivedAt).toBe("2026-06-18T10:00:00Z"); // unchanged
    expect(result.journeyPaused).toBe(false);
    // The already-active journey is left alone (no mutation happened at all).
    expect(db.raw("journeys", "journey_camp1")!.status).toBe("active");
    expect(sink.puts).toHaveLength(0);
    expect(db.dump("audit_events")).toHaveLength(0);
  });

  it("is idempotent: restoring an active launch is a no-op", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1");

    const sink = new FakeAuditSink();
    const result = await setLaunchArchived(ctxAdmin, "camp1", "restore", {}, db, sink);

    expect(result.archivedAt).toBeNull();
    expect(db.raw("campaigns", "camp1")!.archivedAt).toBeUndefined();
    expect(sink.puts).toHaveLength(0);
    expect(db.dump("audit_events")).toHaveLength(0);
  });

  it("applies the state change even if the WORM audit write fails (auditPersisted: false)", async () => {
    const db = new FakeFirestore();
    seedCampaign(db, "ten_A", "camp1");
    seedJourney(db, "ten_A", "camp1", "active");
    const downSink: AuditObjectSink = {
      put: async () => {
        throw new Error("worm store unavailable");
      },
    };

    const result = await setLaunchArchived(ctxAdmin, "camp1", "archive", {}, db, downSink);

    // Archive is reversible and destroys nothing, so an audit hiccup must NOT
    // refuse the close — the mutation stands and the gap is merely reported.
    expect(result.auditPersisted).toBe(false);
    expect(typeof db.raw("campaigns", "camp1")!.archivedAt).toBe("string");
    expect(db.raw("journeys", "journey_camp1")!.status).toBe("paused");
  });
});
