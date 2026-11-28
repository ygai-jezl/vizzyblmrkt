import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { inviteDocId } from "./ids";
import { createWaveDraft, selectInvitees, sendInviteWave, updateWaveDraft, deleteWaveDraft } from "./waves";
import { ctx, seedConnection, seedLaunch, seedSignup } from "./testing/fixtures";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { LoopStamp } from "@/lib/types/loopStamp";

const kick = vi.fn(async () => undefined);
beforeEach(() => {
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  kick.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

function world() {
  const db = new FakeFirestore();
  seedLaunch(db);
  // Rank order: s1, s2, s3, s4, s5, s6 (more referrals = earlier).
  seedSignup(db, "s1", { amountReferred: 5 });
  seedSignup(db, "s2", { amountReferred: 4 });
  seedSignup(db, "s3", { amountReferred: 3, email: null, phone: "+440000000003" });
  seedSignup(db, "s4", { amountReferred: 2 });
  seedSignup(db, "s5", { amountReferred: 1 });
  seedSignup(db, "s6", { amountReferred: 0 });
  seedSignup(db, "gone", { amountReferred: 9, status: "offboarded" });
  return db;
}

describe("invite waves", () => {
  it("can't draft a wave until a production product with a sign-up link exists", async () => {
    const db = world();
    const draft = () => createWaveDraft(ctx, "beta", { size: 2 }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db);
    expect(await draft()).toMatchObject({ ok: false, status: 409, detail: "no_product" });
    seedConnection(db, "pcn_stg", { environment: "staging" });
    expect(await draft()).toMatchObject({ ok: false, detail: "staging_only" });
    seedConnection(db, "pcn_prod", { signupUrl: null });
    expect(await draft()).toMatchObject({ ok: false, detail: "no_signup_url" });
    seedConnection(db, "pcn_prod");
    const ok = await draft();
    expect(ok).toMatchObject({ ok: true, value: { status: "draft", connectionId: "pcn_prod", size: 2, expiresInDays: 30 } });
    if (ok.ok) {
      expect(ok.value.subject).toContain("{{product_name}}");
      expect(ok.value.body).toContain("{{invite_link}}");
    }
    expect(await createWaveDraft(ctx, "nope", { size: 1 }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db)).toMatchObject({ status: 404 });
  });

  it("selects from the top of the ranking, skipping no-email people and existing product users", async () => {
    const db = world();
    seedConnection(db);
    db.seed("product_users", "pu_s2", {
      tenantId: "ten_A",
      connectionId: "pcn_prod",
      emailNormalized: "s2@example.test",
      status: "active",
      lastSeenAt: "2026-09-20T00:00:00.000Z",
    });
    const sel = await selectInvitees(ctx, { campaignId: "beta", connectionId: "pcn_prod", size: 2, excludeExistingUsers: true }, db);
    expect(sel.selected.map((s) => s.id)).toEqual(["s1", "s4"]);
    expect(sel).toMatchObject({ noEmail: 1, existingUsers: 1, alreadyInvited: 0 });
    const all = await selectInvitees(ctx, { campaignId: "beta", connectionId: "pcn_prod", size: 10, excludeExistingUsers: false }, db);
    expect(all.selected.map((s) => s.id)).toEqual(["s1", "s2", "s4", "s5", "s6"]);
  });

  it("sending creates one invite and one queued email per person, and never invites anyone twice", async () => {
    const db = world();
    seedConnection(db);
    const draft = await createWaveDraft(ctx, "beta", { size: 2 }, { authoredBy: "human", userId: "u_admin", made: { unstamped: "person_wrote" } }, db);
    if (!draft.ok) throw new Error("draft failed");
    const sent = await sendInviteWave(ctx, draft.value.id, { userId: "u_admin" }, { db, kick });
    expect(sent).toMatchObject({ ok: true, value: { status: "sent", counts: { selected: 2, created: 2 } } });
    expect(kick).toHaveBeenCalledTimes(1);
    const inv = db.raw("invites", inviteDocId("beta", "s1"));
    expect(inv).toMatchObject({ status: "queued", signupId: "s1", invited: false, connectionId: "pcn_prod" });
    expect(JSON.stringify(inv)).not.toContain("@");
    expect(db.raw("email_jobs", `invite:${inviteDocId("beta", "s1")}`)).toMatchObject({ type: "invite", status: "pending" });

    // The same wave can't be sent twice, and a new wave picks the next people.
    expect(await sendInviteWave(ctx, draft.value.id, {}, { db, kick })).toMatchObject({ ok: false, status: 409 });
    const next = await createWaveDraft(ctx, "beta", { size: 10 }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db);
    if (!next.ok) throw new Error("draft failed");
    const again = await sendInviteWave(ctx, next.value.id, {}, { db, kick });
    expect(again).toMatchObject({ ok: true, value: { counts: { selected: 3, created: 3 } } });
    expect(db.dump("invites")).toHaveLength(5);
  });

  it("only drafts can be edited or deleted", async () => {
    const db = world();
    seedConnection(db);
    const draft = await createWaveDraft(ctx, "beta", { size: 1 }, { authoredBy: "agent", made: { unstamped: "loops_off" } }, db);
    if (!draft.ok) throw new Error("draft failed");
    const edited = await updateWaveDraft(ctx, draft.value.id, { subject: "Come on in", body: "No link yet" }, { db });
    expect(edited).toMatchObject({ ok: true, value: { subject: "Come on in" } });
    if (edited.ok) expect(edited.value.body).toContain("{{invite_link}}");
    await sendInviteWave(ctx, draft.value.id, {}, { db, kick });
    expect(await updateWaveDraft(ctx, draft.value.id, { size: 5 }, { db })).toMatchObject({ ok: false, status: 409 });
    expect(await deleteWaveDraft(ctx, draft.value.id, db)).toMatchObject({ ok: false, status: 409 });
  });

  describe("counting a wave once (learning loops step 5)", () => {
    const vizzy: LoopStamp = { made: "m1.canvas.invite_wave.0.n", kind: "canvas.invite_wave", scope: "canvas.invite_wave", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, by: "vizzy", at: "2026-11-20T10:00:00.000Z" };
    const cell = (db: FakeFirestore) => (sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>> }).c?.["canvas.invite_wave"]?.["canvas.invite_wave"];
    const agentDraft = async (db: FakeFirestore, size = 1) => {
      const d = await createWaveDraft(ctx, "beta", { size }, { authoredBy: "agent", made: vizzy }, db);
      if (!d.ok) throw new Error("draft failed");
      return d.value.id;
    };

    beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

    it("sends Vizzy's copy as kept, or edited once a person changed its words, and counts no made at send", async () => {
      const db = world();
      seedConnection(db);
      const kept = await agentDraft(db);
      await updateWaveDraft(ctx, kept, { size: 2 }, { db });
      await sendInviteWave(ctx, kept, { userId: "u_admin" }, { db, kick });
      const edited = await agentDraft(db);
      await updateWaveDraft(ctx, edited, { subject: "Come on in, Maya" }, { db });
      expect(db.raw("invite_waves", edited)).toMatchObject({ madeEdited: true });
      await sendInviteWave(ctx, edited, { userId: "u_admin" }, { db, kick });
      expect(cell(db)).toEqual({ v0: { none: { kept: 1, edited: 1 } } });
    });

    it("starts unedited again when Vizzy rewrites it, and counts a deleted draft as declined", async () => {
      const db = world();
      seedConnection(db);
      const id = await agentDraft(db);
      await updateWaveDraft(ctx, id, { body: "Sam wrote this {{invite_link}}" }, { db });
      await updateWaveDraft(ctx, id, { body: "Vizzy again {{invite_link}}" }, { db, authoredBy: "agent", made: vizzy });
      expect(db.raw("invite_waves", id)).toMatchObject({ madeEdited: false });
      expect(await deleteWaveDraft(ctx, id, db)).toMatchObject({ ok: true });
      expect(cell(db)).toEqual({ v0: { none: { declined: 1 } } });
    });

    it("counts a person's own wave made once with no stamp, and nothing for their deleted draft", async () => {
      const db = world();
      seedConnection(db);
      const own = await createWaveDraft(ctx, "beta", { size: 1 }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db);
      const gone = await createWaveDraft(ctx, "beta", { size: 1 }, { authoredBy: "human", made: { unstamped: "person_wrote" } }, db);
      if (!own.ok || !gone.ok) throw new Error("draft failed");
      await updateWaveDraft(ctx, own.value.id, { subject: "Hello from Hearth" }, { db });
      expect(db.raw("invite_waves", own.value.id)).not.toHaveProperty("madeEdited");
      await sendInviteWave(ctx, own.value.id, {}, { db, kick });
      await deleteWaveDraft(ctx, gone.value.id, db);
      expect(sumWeek(db, ctx.tenantId, loopWeekOf(new Date()))).toEqual({ u: { "canvas.invite_wave": { person_wrote: 1 } }, t: { invite_wave: { made: 1 } } });
    });

    it("with LOOPS_ENABLED off keeps no marks and counts nothing (decision 22)", async () => {
      vi.stubEnv("LOOPS_ENABLED", "");
      const db = world();
      seedConnection(db);
      const id = await agentDraft(db);
      await updateWaveDraft(ctx, id, { subject: "Come on in" }, { db });
      expect(db.raw("invite_waves", id)).not.toHaveProperty("madeEdited");
      await sendInviteWave(ctx, id, {}, { db, kick });
      expect(db.dump("loop_days")).toEqual([]);
    });
  });
});
