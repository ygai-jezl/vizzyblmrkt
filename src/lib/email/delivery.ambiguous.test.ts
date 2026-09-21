import { vi, describe, it, expect, beforeEach } from "vitest";

// The provider answer is the variable under test. The tenant registry and the
// waitlist rank scan would otherwise reach real Firestore, so they're stubbed.
// Kept in a SEPARATE file so these module mocks don't disturb delivery.test.ts.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});
vi.mock("@/lib/waitlist/rank", () => ({ computeRanks: vi.fn(async () => new Map()) }));

import { processEmailJobs } from "./delivery";
import { sendEmail } from "@/lib/email";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const send = sendEmail as unknown as ReturnType<typeof vi.fn>;

const AMBIGUOUS = { sent: false, provider: "mandrill", reason: "timeout", ambiguous: true };
const DEFINITE = { sent: false, provider: "mandrill", reason: "http_400" };

function job(id: string, type: string, payload: Record<string, unknown>) {
  return {
    tenantId: "ten_A",
    campaignId: "camp1",
    type,
    status: "pending",
    dedupeKey: id,
    scheduledAt: "2020-01-01T00:00:00.000Z", // due
    attempts: 0,
    claimedAt: null,
    emailSentAt: null,
    payload,
    lastError: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    processedAt: null,
  };
}

describe("ambiguous sends are treated as sent — never retried", () => {
  beforeEach(() => vi.clearAllMocks());

  function seedOffboarding(db: FakeFirestore) {
    db.seed("campaigns", "camp1", {
      id: "camp1",
      tenantId: "ten_A",
      waitlistName: "Test Launch",
      offboardingEmail: { enabled: true },
    });
    db.seed("signups", "s1", {
      id: "s1",
      tenantId: "ten_A",
      campaignId: "camp1",
      status: "offboarded",
      verified: true,
      email: "a@b.com",
    });
    db.seed("email_jobs", "offboard:s1", job("offboard:s1", "lifecycle", { signupId: "s1" }));
  }

  it("stamps an ambiguous offboarding send as sent and never resends it", async () => {
    send.mockResolvedValue(AMBIGUOUS);
    const db = new FakeFirestore();
    seedOffboarding(db);

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({
      status: "done",
      sendAmbiguous: "timeout",
    });
    expect(db.raw("email_jobs", "offboard:s1")?.emailSentAt).toEqual(expect.any(String));

    await processEmailJobs(ctx, 25, db); // a later drain
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still retries a definite failure", async () => {
    send.mockResolvedValue(DEFINITE);
    const db = new FakeFirestore();
    seedOffboarding(db);

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({
      status: "pending",
      attempts: 1,
      emailSentAt: null,
      lastError: "send:http_400",
    });
  });

  it("advances a journey past an ambiguous step without resending it", async () => {
    send.mockResolvedValue(AMBIGUOUS);
    const db = new FakeFirestore();
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hello" } },
        { id: "wait1", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 24 } },
        { id: "email2", type: "email", position: { x: 0, y: 0 }, data: { subject: "Again", body: "Hello" } },
      ],
      edges: [
        { id: "e0", source: "trigger", target: "email1", sourceHandle: null },
        { id: "e1", source: "email1", target: "wait1", sourceHandle: null },
        { id: "e2", source: "wait1", target: "email2", sourceHandle: null },
      ],
    } as unknown as JourneyGraph;
    db.seed("journeys", "journey_camp1", {
      tenantId: "ten_A",
      campaignId: "camp1",
      status: "active",
      graph,
      createdAt: "2026-06-19T00:00:00Z",
      updatedAt: "2026-06-19T00:00:00Z",
    });
    db.seed("campaigns", "camp1", {
      id: "camp1",
      tenantId: "ten_A",
      waitlistName: "Test Launch",
      archivedAt: null,
    });
    db.seed("signups", "s1", {
      id: "s1",
      tenantId: "ten_A",
      campaignId: "camp1",
      status: "verified_active",
      email: "a@b.com",
    });
    const first = "journey:journey_camp1:email1:s1";
    db.seed(
      "email_jobs",
      first,
      job(first, "journey_step", { journeyId: "journey_camp1", nodeId: "email1", signupId: "s1" }),
    );

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.raw("email_jobs", first)).toMatchObject({ status: "done", sendAmbiguous: "timeout" });
    // The chain moved on: the next step is queued, not a retry of this one.
    expect(db.raw("email_jobs", "journey:journey_camp1:email2:s1")).toMatchObject({
      status: "pending",
    });
  });
});
