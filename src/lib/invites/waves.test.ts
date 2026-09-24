import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { inviteDocId } from "./ids";
import { createWaveDraft, selectInvitees, sendInviteWave, updateWaveDraft, deleteWaveDraft } from "./waves";
import { ctx, seedConnection, seedLaunch, seedSignup } from "./testing/fixtures";

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
    const draft = () => createWaveDraft(ctx, "beta", { size: 2 }, { authoredBy: "human" }, db);
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
    expect(await createWaveDraft(ctx, "nope", { size: 1 }, { authoredBy: "human" }, db)).toMatchObject({ status: 404 });
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
    const draft = await createWaveDraft(ctx, "beta", { size: 2 }, { authoredBy: "human", userId: "u_admin" }, db);
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
    const next = await createWaveDraft(ctx, "beta", { size: 10 }, { authoredBy: "human" }, db);
    if (!next.ok) throw new Error("draft failed");
    const again = await sendInviteWave(ctx, next.value.id, {}, { db, kick });
    expect(again).toMatchObject({ ok: true, value: { counts: { selected: 3, created: 3 } } });
    expect(db.dump("invites")).toHaveLength(5);
  });

  it("only drafts can be edited or deleted", async () => {
    const db = world();
    seedConnection(db);
    const draft = await createWaveDraft(ctx, "beta", { size: 1 }, { authoredBy: "agent" }, db);
    if (!draft.ok) throw new Error("draft failed");
    const edited = await updateWaveDraft(ctx, draft.value.id, { subject: "Come on in", body: "No link yet" }, { db });
    expect(edited).toMatchObject({ ok: true, value: { subject: "Come on in" } });
    if (edited.ok) expect(edited.value.body).toContain("{{invite_link}}");
    await sendInviteWave(ctx, draft.value.id, {}, { db, kick });
    expect(await updateWaveDraft(ctx, draft.value.id, { size: 5 }, { db })).toMatchObject({ ok: false, status: 409 });
    expect(await deleteWaveDraft(ctx, draft.value.id, db)).toMatchObject({ ok: false, status: 409 });
  });
});
