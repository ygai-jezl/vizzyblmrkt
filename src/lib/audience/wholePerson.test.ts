import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { inviteDocId } from "@/lib/invites/ids";
import { waitlistEnrolmentId, waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { personIdOf, syncPerson } from "./personSync";
import { loadWholePerson } from "./wholePerson";
import { addPerson, withdrawHandConsent } from "./addPerson";
import { parseNewPerson } from "./newPerson";

/** One whole person, from made-up people at .test. */

describe("loadWholePerson", () => {
  it("brings their launches (with invite and waitlist journey) and their products together", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("campaigns", "camp1", { tenantId: TENANT_ID, waitlistName: "Beta waitlist" });
    db.seed("signups", "s_ada", {
      tenantId: TENANT_ID,
      campaignId: "camp1",
      email: "ada@customer.test",
      firstName: "Ada",
      status: "verified_active",
      amountReferred: 3,
      referralToken: "r",
      referralLink: "https://example.test/r",
      score: 0,
      joinedVia: "site",
      createdAt: new Date(T0).toISOString(),
    });
    db.seed("invites", inviteDocId("camp1", "s_ada"), { tenantId: TENANT_ID, campaignId: "camp1", signupId: "s_ada", invited: true, signedUp: true, activated: false });
    db.seed("waitlist_enrolments", waitlistEnrolmentId(waitlistJourneyId("camp1"), "s_ada"), {
      tenantId: TENANT_ID,
      signupId: "s_ada",
      status: "active",
      sentItems: [{ nodeId: "n1" }, { nodeId: "n2" }],
    });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });

    const id = personIdOf(TENANT_ID, "ada@customer.test");
    const p = (await loadWholePerson(ctx, id, db))!;
    expect(p).toMatchObject({ id, name: "Ada", email: "ada@customer.test", reach: "yes" });
    expect(p.launches).toEqual([
      expect.objectContaining({ campaignId: "camp1", name: "Beta waitlist", status: "verified_active", via: "site", referrals: 3, invite: "signed_up", journey: { status: "active", sent: 2 } }),
    ]);
    expect(p.products).toEqual([expect.objectContaining({ connectionId: CONNECTION_ID, name: "Sandbox", stage: "new" })]);
    expect(await loadWholePerson({ ...ctx, tenantId: "ten_other" }, id, db)).toBeNull();
  });
});

describe("loadWholePerson with fields", () => {
  it("adds their values for fields in use, fields from elsewhere and voice chats, and nothing while off", async () => {
    const { saveFieldListChange } = await import("./fieldList");
    const { setRecordFieldValues } = await import("@/lib/tenant");
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("campaigns", "camp1", { tenantId: TENANT_ID, waitlistName: "Beta waitlist" });
    db.seed("signups", "s_ada", {
      tenantId: TENANT_ID,
      campaignId: "camp1",
      email: "ada@customer.test",
      status: "verified_active",
      amountReferred: 0,
      referralToken: "r",
      referralLink: "https://example.test/r",
      score: 0,
      answers: [{ question_value: "Your role?", optional: true, answer_value: "Founder" }],
      aiConversation: { completed: true, transcript: [{ role: "user", text: "hello there" }], summary: "Wants exports.", capturedAt: new Date(T0).toISOString(), bonusApplied: false },
      createdAt: new Date(T0).toISOString(),
    });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const id = personIdOf(TENANT_ID, "ada@customer.test");
    const by = { type: "member", id: "u_admin" } as const;
    const at = new Date(T0).toISOString();
    await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, nowIso: at, newFieldId: () => "fld_000000000001" }, db);
    await saveFieldListChange(ctx, "person", { baseRev: 1, change: { op: "add", label: "Old", type: "text" }, by, nowIso: at, newFieldId: () => "fld_000000000002" }, db);
    await setRecordFieldValues(ctx, { object: "person", recordId: id, changes: { fld_000000000001: 12, fld_000000000002: "kept" }, by, source: "editor", nowIso: at }, { db });
    await saveFieldListChange(ctx, "person", { baseRev: 2, change: { op: "archive", key: "fld_000000000002" }, by, nowIso: at }, db);

    expect((await loadWholePerson(ctx, id, db))!.fields).toBeNull();
    const p = (await loadWholePerson(ctx, id, db, { fields: true }))!;
    expect(p.fields!.values).toEqual({ fld_000000000001: 12 });
    expect(p.fields!.readOnly.map((v) => [v.label, v.value, v.source])).toEqual([
      ["Your role?", "Founder", "Sign-up answer · Beta waitlist"],
      ["Stage", "New", "Sandbox"],
      ["Plan", "free", "Sandbox trait"],
    ]);
    expect(p.fields!.voiceChats).toEqual([{ signupId: "s_ada", launchName: "Beta waitlist", summary: "Wants exports.", at, turns: 1 }]);
    expect(JSON.stringify(p)).not.toContain("hello there");
  });
});

describe("loadWholePerson with groups", () => {
  it("names each product's groups they belong to, only when asked", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const at = new Date(T0).toISOString();
    seedUser(db, "ada", {
      email: "ada@customer.test",
      emailNormalized: "ada@customer.test",
      entities: { "org.acme:team-1": { kind: "workspace", name: "Acme Labs", parentId: null, role: "owner", steps: {}, facts: {}, activeAt: null, firstSeenAt: at, updatedAt: at } },
    });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const id = personIdOf(TENANT_ID, "ada@customer.test");
    expect((await loadWholePerson(ctx, id, db))!.products[0]!.groups).toBeUndefined();
    expect((await loadWholePerson(ctx, id, db, { groups: true }))!.products[0]!.groups).toEqual([{ id: "org.acme:team-1", name: "Acme Labs", kind: "workspace" }]);
  });
});

describe("loadWholePerson for someone added by hand", () => {
  it("says who added them and how they agreed, with names looked up now, and null for everyone else", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("tenant_users", "m1", { tenantId: TENANT_ID, userId: "usr_1", role: "admin" });
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam", agreed: { how: "other", note: "At our stand" } });
    if (!sam.ok) throw new Error(sam.error);
    const at = new Date(T0).toISOString();
    await addPerson(ctx, sam.value, { db, nowIso: at });
    const lookup = async (uids: string[]) => uids.map((uid) => ({ uid, displayName: "Alex Morgan" }));
    const p = (await loadWholePerson(ctx, personIdOf(TENANT_ID, "sam@labs.test"), db, { lookup }))!;
    expect(p.added).toEqual({ by: "Alex Morgan", at, via: "form", consent: { how: "other", howLabel: "Other", note: "At our stand", by: "Alex Morgan", at }, withdrawn: null });
    expect(p.reach).toBe("yes");

    // Once they leave the team, the record names nobody.
    db.seed("tenant_users", "m1", { tenantId: "ten_other", userId: "usr_1", role: "admin" });
    const later = (await loadWholePerson(ctx, personIdOf(TENANT_ID, "sam@labs.test"), db, { lookup }))!;
    expect(later.added).toMatchObject({ by: "Former team member", consent: { by: "Former team member" } });

    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    expect((await loadWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), db))!.added).toBeNull();
  });

  it("says when the team withdrew the agreement, and they can't be emailed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("tenant_users", "m1", { tenantId: TENANT_ID, userId: "usr_1", role: "admin" });
    const sam = parseNewPerson({ email: "sam@labs.test", agreed: { how: "in_person" } });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: new Date(T0).toISOString() });
    const later = new Date(T0 + 60_000).toISOString();
    await withdrawHandConsent(ctx, personIdOf(TENANT_ID, "sam@labs.test"), { note: null }, { db, nowIso: later });
    const lookup = async (uids: string[]) => uids.map((uid) => ({ uid, displayName: "Alex Morgan" }));
    const p = (await loadWholePerson(ctx, personIdOf(TENANT_ID, "sam@labs.test"), db, { lookup }))!;
    expect(p.added).toMatchObject({ consent: null, withdrawn: { note: null, by: "Alex Morgan", at: later } });
    expect(p.reach).toBe("no");
  });
});
