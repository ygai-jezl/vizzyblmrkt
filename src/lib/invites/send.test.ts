import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { sendEmail } from "@/lib/email";
import { getTenantById } from "@/lib/tenant";
import type { Tenant } from "@/lib/types/tenant";
import { processEmailJobs } from "@/lib/email/delivery";
import { suppressEmail } from "@/lib/email/suppression";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { inviteDocId } from "./ids";
import { createWaveDraft, sendInviteWave } from "./waves";
import { ctx, seedConnection, seedLaunch, seedSignup } from "./testing/fixtures";
import { personIdForSignup } from "@/lib/ontology/personRef";
import { metadataBytes, METADATA_LIMIT_BYTES } from "@/lib/email/mandrillWebhook";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { LoopStamp } from "@/lib/types/loopStamp";

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
  const draft = await createWaveDraft(ctx, "beta", { size }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db);
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

  it("wears the saved Email style when it's switched on", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    const { db } = await queuedWave();
    const emailStyle = { logo: null, companyName: null, headerColor: "#0b1f3a", accentColor: "#1d4ed8" };
    vi.mocked(getTenantById).mockResolvedValueOnce({ id: "ten_A", tenantName: "Fernlight Co", emailStyle } as unknown as Tenant);
    await processEmailJobs(ctx, 25, db);
    const html = String(send.mock.calls[0]![0].html);
    expect(html).toContain('bgcolor="#0b1f3a"');
    expect(html).toContain(">Fernlight Co</span>");
    expect(html).toContain("background:#1d4ed8;color:#ffffff;");
  });
});

describe("the person on an invite's send (ONTOLOGY_PERSON_IDS_ENABLED)", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });

  it("is on the send record and the send row, never in the metadata", async () => {
    const { db } = await queuedWave();
    await processEmailJobs(ctx, 25, db);
    const person = personIdForSignup(ctx.tenantId, { email: "s1@example.test", phone: null });
    const msg = send.mock.calls[0]![0];
    expect(Object.keys(msg.metadata)).toEqual(["t", "s"]);
    expect(JSON.stringify(msg.metadata)).not.toContain("ct_");
    expect(metadataBytes(msg.metadata)).toBeLessThanOrEqual(METADATA_LIMIT_BYTES);
    expect(db.raw("email_sends", msg.metadata.s)).toMatchObject({ engine: "invite", signupId: "s1", personId: person });
    expect(db.dump("email_events")).toEqual([expect.objectContaining({ type: "send", personId: person })]);
  });

  it("is not written while the switch is off", async () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    const { db } = await queuedWave();
    await processEmailJobs(ctx, 25, db);
    expect(db.dump("email_sends")[0]).not.toHaveProperty("personId");
    expect(db.dump("email_events")[0]).not.toHaveProperty("personId");
  });
});

describe("a wave's stamp on its invites (LOOPS_ENABLED, learning loops step 5)", () => {
  const vizzy: LoopStamp = { made: "m1.canvas.invite_wave.0.n", kind: "canvas.invite_wave", scope: "canvas.invite_wave", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, by: "vizzy", at: "2026-11-20T10:00:00.000Z" };
  const week = (db: FakeFirestore) => sumWeek(db, ctx.tenantId, loopWeekOf(new Date()));

  async function vizzyWave() {
    const db = new FakeFirestore();
    seedLaunch(db);
    seedConnection(db);
    seedSignup(db, "s1", { amountReferred: 3 });
    seedSignup(db, "s2", { amountReferred: 2 });
    seedSignup(db, "s3", { amountReferred: 1 });
    const draft = await createWaveDraft(ctx, "beta", { size: 3 }, { authoredBy: "agent", made: vizzy }, db);
    if (!draft.ok) throw new Error("draft failed");
    await sendInviteWave(ctx, draft.value.id, {}, { db, kick: noKick });
    return db;
  }

  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("counts nothing per invite with send records off: the wave is one made thing and keeps its own stamp", async () => {
    const db = await vizzyWave();
    await processEmailJobs(ctx, 25, db);
    expect(send).toHaveBeenCalledTimes(3);
    expect(week(db)).toEqual({ c: { "canvas.invite_wave": { "canvas.invite_wave": { v0: { none: { kept: 1 } } } } } });
  });

  it("counts nothing for an invite whose send failed and was tried again", async () => {
    const db = await vizzyWave();
    send.mockResolvedValue({ sent: false, provider: "mandrill", reason: "http_400" });
    await processEmailJobs(ctx, 25, db);
    expect(week(db)).toEqual({ c: { "canvas.invite_wave": { "canvas.invite_wave": { v0: { none: { kept: 1 } } } } } });
  });

  it("keeps the wave's stamp on each invite's send record with send records on", async () => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true");
    const db = await vizzyWave();
    await processEmailJobs(ctx, 25, db);
    expect(db.dump("email_sends")).toHaveLength(3);
    for (const rec of db.dump("email_sends")) expect(rec.made).toMatchObject({ made: vizzy.made, kind: "canvas.invite_wave" });
    expect(week(db)).not.toHaveProperty("u");
  });
});
