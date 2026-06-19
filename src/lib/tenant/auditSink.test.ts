import { describe, it, expect, afterEach } from "vitest";
import { gcsAuditSink, isPreconditionFailed } from "./auditSink";
import { auditObjectPath, auditEntryId, type LaunchDeletionAudit } from "./audit";

const entry: LaunchDeletionAudit = {
  action: "launch.delete",
  tenantId: "ten_A",
  region: "us",
  campaignId: "camp1",
  campaignName: "Camp One",
  status: "completed",
  deleted: { campaigns: 1, signups: 2, broadcasts: 0, journeys: 0, emailJobs: 0 },
  createdAt: "2026-06-19T10:23:06.123Z",
};

describe("auditSink helpers", () => {
  afterEach(() => {
    delete process.env.AUDIT_LOG_BUCKET;
  });

  it("derives a stable, filesystem-safe object path from the entry", () => {
    // Colons in the ISO timestamp are sanitized to underscores; dots survive.
    expect(auditEntryId(entry)).toBe("ten_A_camp1_2026-06-19T10_23_06.123Z_completed");
    expect(auditObjectPath(entry)).toBe(
      "audit/launch-delete/ten_A_camp1_2026-06-19T10_23_06.123Z_completed.json",
    );
  });

  it("recognizes a 412 precondition failure (object already exists) and nothing else", () => {
    expect(isPreconditionFailed({ code: 412 })).toBe(true);
    expect(isPreconditionFailed({ code: "412" })).toBe(true);
    expect(isPreconditionFailed({ code: 403 })).toBe(false);
    expect(isPreconditionFailed(new Error("nope"))).toBe(false);
    expect(isPreconditionFailed(null)).toBe(false);
    expect(isPreconditionFailed(undefined)).toBe(false);
  });

  it("is a no-op when AUDIT_LOG_BUCKET is unset (local dev / tests need no bucket)", async () => {
    delete process.env.AUDIT_LOG_BUCKET;
    const sink = gcsAuditSink();
    // Must resolve without touching GCS.
    await expect(sink.put("audit/launch-delete/x.json", "{}")).resolves.toBeUndefined();
  });
});
