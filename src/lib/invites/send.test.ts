import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { sendEmail } from "@/lib/email";
import { processEmailJobs } from "@/lib/email/delivery";
import { suppressEmail } from "@/lib/email/suppression";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { inviteDocId } from "./ids";
import { createWaveDraft, sendInviteWave } from "./waves";
import { ctx, seedConnection, seedLaunch, seedSignup } from "./testing/fixtures";

const send = sendEmail as unknown as ReturnType<typeof vi.fn>;
const noKick = async () => undefined;

beforeEach(() => {
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  vi.stubEnv("INVITES_ENABLED", "true");
  send.mockReset();
  send.mockResolvedValue({ sent: true, provider: "mandrill", id: "msg_1" });
});
afterEach(() => vi.unstubAllEnvs());

async function queuedWave(size = 1) {
  const db = new FakeFirestore();
  seedLaunch(db);
  seedConnection(db);
  seedSignup(db, "s1", { amountReferred: 2 });
  seedSignup(db, "s2", { amountReferred: 1 });
  const draft = await createWaveDraft(ctx, "beta", { size }, { authoredBy: "human" }, db);
  if (!draft.ok) throw new Error("draft failed");
  await sendInviteWave(ctx, draft.value.id, {}, { db, kick: noKick });
  return { db, waveId: draft.value.id, inviteId: inviteDocId("beta", "s1"), jobId: `invite:${inviteDocId("beta", "s1")}` };
}

describe("sending an invite", () => {
  it("sends once, then marks it invited and takes the person off the waitlist (no offboarding email)", async () => {
    const { db, inviteId, jobId, waveId } = await queuedWave();
    await processEmailJobs(ctx, 25, db);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0];
    expect(msg.to).toBe("s1@example.test");
    expect(msg.html).toContain("https://yougrow.test/invite/");
    expect(msg.metadata).toMatchObject({ journeyId: "invite_beta", nodeId: waveId, signupId: "s1" });
    expect(msg.listUnsubscribe).toBeTruthy();
    expect(db.raw("invites", inviteId)).toMatchObject({ status: "invited", invited: true });
    expect(db.raw("invites", inviteId)?.expiresAt).toBeTruthy();
    expect(db.raw("signups", "s1")).toMatchObject({ status: "offboarded", offboardReason: "invited", inviteId });
    expect(db.raw("email_jobs", jobId)).toMatchObject({ status: "done", mandrillMessageId: "msg_1" });
    expect(db.dump("email_events")).toEqual([expect.objectContaining({ type: "send", journeyId: "invite_beta" })]);
    expect(db.dump("email_jobs").filter((j) => j.type === "lifecycle")).toHaveLength(0);
  });

  it("a retry after the send never sends again, it only finishes the bookkeeping", async () => {
    const { db, inviteId, jobId } = await queuedWave();
    db.seed("email_jobs", jobId, { ...db.raw("email_jobs", jobId)!, emailSentAt: "2026-09-24T10:00:00.000Z" });
    await processEmailJobs(ctx, 25, db);
    expect(send).not.toHaveBeenCalled();
    expect(db.raw("invites", inviteId)).toMatchObject({ invited: true });
    expect(db.raw("signups", "s1")).toMatchObject({ status: "offboarded", offboardReason: "invited" });
  });

  it("unsubscribed or no-longer-verified people are skipped and stay on the waitlist", async () => {
    const { db, inviteId } = await queuedWave();
    await suppressEmail(ctx, { email: "s1@example.test", reason: "unsubscribe", source: "footer" }, db);
    await processEmailJobs(ctx, 25, db);
    expect(send).not.toHaveBeenCalled();
    expect(db.raw("invites", inviteId)).toMatchObject({ status: "skipped", skipReason: "unsubscribed", invited: false });
    expect(db.raw("signups", "s1")).toMatchObject({ status: "verified_active" });

    const second = await queuedWave();
    second.db.seed("signups", "s1", { ...second.db.raw("signups", "s1")!, status: "unverified" });
    await processEmailJobs(ctx, 25, second.db);
    expect(second.db.raw("invites", second.inviteId)).toMatchObject({ status: "skipped", skipReason: "left_waitlist" });
  });

  it("while invites are switched off, queued invites wait instead of failing", async () => {
    const { db, jobId } = await queuedWave();
    vi.stubEnv("INVITES_ENABLED", "false");
    await processEmailJobs(ctx, 25, db);
    expect(send).not.toHaveBeenCalled();
    const job = db.raw("email_jobs", jobId)!;
    expect(job).toMatchObject({ status: "pending", attempts: 0 });
    expect(Date.parse(String(job.scheduledAt))).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("when every attempt fails, the invite is marked failed and the person stays on the waitlist", async () => {
    const { db, inviteId, jobId } = await queuedWave();
    send.mockResolvedValue({ sent: false, provider: "mandrill", reason: "rejected" });
    for (let i = 0; i < 3; i += 1) await processEmailJobs(ctx, 25, db);
    expect(send).toHaveBeenCalledTimes(3);
    expect(db.raw("email_jobs", jobId)).toMatchObject({ status: "failed" });
    expect(db.raw("invites", inviteId)).toMatchObject({ status: "failed", invited: false });
    expect(db.raw("signups", "s1")).toMatchObject({ status: "verified_active" });
  });

  it("a cancelled wave's unsent invites are cancelled, not sent", async () => {
    const { db, inviteId, waveId } = await queuedWave();
    db.seed("invite_waves", waveId, { ...db.raw("invite_waves", waveId)!, status: "cancelled" });
    await processEmailJobs(ctx, 25, db);
    expect(send).not.toHaveBeenCalled();
    expect(db.raw("invites", inviteId)).toMatchObject({ status: "cancelled" });
  });
});
