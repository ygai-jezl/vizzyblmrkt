import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import { IdeaChangeSchema, planIdea, setIdea } from "./service";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const other: TenantContext = { ...admin, tenantId: "ten_B" };
const T1 = "2026-11-18T10:00:00.000Z";
const T2 = "2026-11-25T09:00:00.000Z";

function world(idea?: Record<string, unknown>, extra: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("campaigns", "team-spaces", {
    tenantId: "ten_A",
    waitlistName: "Team spaces",
    createdAt: "2026-10-28T09:00:00.000Z",
    ...(idea ? { idea } : {}),
    ...extra,
  });
  db.seed("product_connections", "pcn_app", { tenantId: "ten_A", kind: "custom", status: "active", name: "Lumen app" });
  db.seed("product_connections", "pcn_gone", { tenantId: "ten_A", kind: "custom", status: "revoked", name: "Old app" });
  db.seed("product_connections", "pcn_theirs", { tenantId: "ten_B", kind: "custom", status: "active", name: "Their app" });
  return db;
}

const ideaOf = (db: FakeFirestore) => db.raw("campaigns", "team-spaces")?.idea as Record<string, unknown> | undefined;
const events = (db: FakeFirestore) => db.dump("ontology_events") as unknown as StoredEvent[];
const noClose = vi.fn(async () => undefined);

describe("setIdea", () => {
  it("keeps who set the status and when, with a record.field_changed event in the same commit", async () => {
    const db = world();
    const r = await setIdea(admin, "team-spaces", { status: "testing" }, { db, nowIso: T1 });
    expect(r).toEqual({ ok: true, changed: true, archived: null, idea: { status: "testing", statusAt: T1, statusBy: "usr_admin" } });
    expect(ideaOf(db)).toEqual({ status: "testing", statusAt: T1, statusBy: "usr_admin" });
    const [e] = events(db);
    expect(events(db)).toHaveLength(1);
    expect(e).toMatchObject({
      kind: "record.field_changed",
      subjectKey: "idea:team-spaces",
      personId: null,
      fieldId: "sys.idea.status",
      actor: { type: "member", id: "usr_admin" },
      properties: { fieldId: "sys.idea.status", object: "idea", before: null, after: "testing", source: "editor" },
    });
  });

  it("writes nothing for the status it already has", async () => {
    const db = world({ status: "testing", statusAt: T1, statusBy: "usr_admin" });
    const r = await setIdea(admin, "team-spaces", { status: "testing" }, { db, nowIso: T2 });
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(ideaOf(db)).toMatchObject({ statusAt: T1 });
    expect(events(db)).toHaveLength(0);
  });

  it("saves hypothesis and outcome trimmed, clears them as null, and makes no event for them", async () => {
    const db = world({ status: "testing", statusAt: T1, statusBy: "usr_admin" });
    const change = IdeaChangeSchema.parse({ hypothesis: "  Teams will pay for their own spaces.  ", outcome: "" });
    await setIdea(admin, "team-spaces", change, { db, nowIso: T2 });
    expect(ideaOf(db)).toEqual({ status: "testing", statusAt: T1, statusBy: "usr_admin", hypothesis: "Teams will pay for their own spaces.", outcome: null });
    await setIdea(admin, "team-spaces", { hypothesis: null }, { db, nowIso: T2 });
    expect(ideaOf(db)).toMatchObject({ hypothesis: null });
    expect(Object.hasOwn(ideaOf(db)!, "hypothesis")).toBe(true);
    expect(events(db)).toHaveLength(0);
  });

  it("parks without closing the waitlist unless asked, and closes it after the status commits", async () => {
    const db = world({ status: "testing" });
    const close = vi.fn(async () => undefined);
    const parked = await setIdea(admin, "team-spaces", { status: "parked" }, { db, nowIso: T1, archive: close });
    expect(parked).toMatchObject({ ok: true, archived: null });
    expect(close).not.toHaveBeenCalled();

    const closed = await setIdea(admin, "team-spaces", { closeWaitlist: true }, { db, nowIso: T2, archive: close });
    expect(closed).toMatchObject({ ok: true, changed: false, archived: true });
    expect(close).toHaveBeenCalledWith(admin, "team-spaces");
  });

  it("keeps the status when closing the waitlist fails, and says it didn't close", async () => {
    const db = world({ status: "testing" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await setIdea(admin, "team-spaces", { status: "killed", closeWaitlist: true }, { db, nowIso: T1, archive: async () => Promise.reject(new Error("audit down")) });
    spy.mockRestore();
    expect(r).toMatchObject({ ok: true, changed: true, archived: false, idea: { status: "killed" } });
    expect(ideaOf(db)).toMatchObject({ status: "killed" });
    expect(events(db)).toHaveLength(1);
  });

  it("closes the waitlist with the real archive path, which pauses nothing that isn't live", async () => {
    const db = world({ status: "parked" });
    const r = await setIdea(admin, "team-spaces", { closeWaitlist: true }, { db, nowIso: T1 });
    expect(r).toMatchObject({ ok: true, archived: true });
    expect(db.raw("campaigns", "team-spaces")?.archivedAt).toEqual(expect.any(String));
  });

  it("refuses to close the waitlist of an idea that isn't parked or killed", async () => {
    const db = world({ status: "testing" });
    const r = await setIdea(admin, "team-spaces", { closeWaitlist: true }, { db, nowIso: T1, archive: noClose });
    expect(r).toEqual({ ok: false, status: 400, error: "not_parked_or_killed" });
    expect(noClose).not.toHaveBeenCalled();
    expect(ideaOf(db)).toEqual({ status: "testing" });
  });

  it("hands a launched idea off to one of the brand's products, as an event, and again when it changes", async () => {
    const db = world();
    db.seed("product_connections", "pcn_web", { tenantId: "ten_A", kind: "custom", status: "active", name: "Lumen web" });
    const r = await setIdea(admin, "team-spaces", { status: "launched", productConnectionId: "pcn_app" }, { db, nowIso: T1 });
    expect(r).toMatchObject({ ok: true, idea: { status: "launched", productConnectionId: "pcn_app", handedOffAt: T1, handedOffBy: "usr_admin" } });
    expect(events(db).map((e) => [e.fieldId, e.properties])).toEqual([
      ["sys.idea.status", expect.objectContaining({ before: null, after: "launched" })],
      ["sys.idea.product", expect.objectContaining({ before: null, after: "pcn_app" })],
    ]);

    await setIdea(admin, "team-spaces", { productConnectionId: "pcn_web" }, { db, nowIso: T2 });
    expect(ideaOf(db)).toMatchObject({ productConnectionId: "pcn_web", handedOffAt: T2 });
    expect(events(db).filter((e) => e.fieldId === "sys.idea.product").map((e) => e.properties.after)).toEqual(["pcn_app", "pcn_web"]);
  });

  it("keeps the hand-off when the idea leaves Launched", async () => {
    const db = world({ status: "launched", productConnectionId: "pcn_app", handedOffAt: T1, handedOffBy: "usr_admin" });
    await setIdea(admin, "team-spaces", { status: "validated" }, { db, nowIso: T2 });
    expect(ideaOf(db)).toMatchObject({ status: "validated", productConnectionId: "pcn_app", handedOffAt: T1 });
  });

  it("hands off only a launched idea, to a product of this brand that isn't revoked", async () => {
    const db = world({ status: "validated" });
    expect(await setIdea(admin, "team-spaces", { productConnectionId: "pcn_app" }, { db })).toEqual({ ok: false, status: 400, error: "not_launched" });
    const launched = world({ status: "launched" });
    for (const id of ["pcn_gone", "pcn_theirs", "pcn_none"]) {
      expect(await setIdea(admin, "team-spaces", { productConnectionId: id }, { db: launched })).toEqual({ ok: false, status: 400, error: "product_not_found" });
    }
    expect(events(db)).toHaveLength(0);
    expect(events(launched)).toHaveLength(0);
  });

  it("marks a launch Just a list, and back", async () => {
    const db = world();
    await setIdea(admin, "team-spaces", { justAList: true }, { db });
    expect(ideaOf(db)).toEqual({ justAList: true });
    await setIdea(admin, "team-spaces", { justAList: false }, { db });
    expect(ideaOf(db)).toEqual({ justAList: false });
  });

  it("finds no launch of another brand, or none at all, and refuses an id events can't name", async () => {
    const db = world();
    expect(await setIdea(other, "team-spaces", { status: "testing" }, { db })).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await setIdea(admin, "no-such-launch", { status: "testing" }, { db })).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await setIdea(admin, "a/b", { status: "testing" }, { db })).toEqual({ ok: false, status: 400, error: "invalid_id" });
    expect(ideaOf(db)).toBeUndefined();
    expect(events(db)).toHaveLength(0);
  });

  it("records no address as who set it", async () => {
    const db = world();
    await setIdea({ ...admin, userId: "sam@example.com" }, "team-spaces", { status: "exploring" }, { db, nowIso: T1 });
    expect(ideaOf(db)).toMatchObject({ statusBy: null });
  });
});

describe("IdeaChangeSchema", () => {
  it("is strict, needs something to change, and keeps to the limits", () => {
    expect(IdeaChangeSchema.safeParse({}).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ status: "testing", tenantId: "ten_B" }).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ status: "archived" }).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ closeWaitlist: false }).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ hypothesis: "a".repeat(501) }).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ hypothesis: `  ${"a".repeat(500)}  ` }).success).toBe(true);
    expect(IdeaChangeSchema.safeParse({ outcome: "a".repeat(2001) }).success).toBe(false);
    expect(IdeaChangeSchema.safeParse({ productConnectionId: "../x" }).success).toBe(false);
  });
});

describe("planIdea", () => {
  it("is pure: the same change plans the same idea twice, as a retried transaction does", () => {
    const current = { id: "team-spaces", idea: { status: "testing" as const } } as never;
    const who = { userId: "usr_admin", actor: { type: "member" as const, id: "usr_admin" }, nowIso: T1 };
    const a = planIdea(current, { status: "validated" }, who);
    const b = planIdea(current, { status: "validated" }, who);
    expect("idea" in a && a.idea).toEqual("idea" in b && b.idea);
    expect((current as { idea: unknown }).idea).toEqual({ status: "testing" });
  });
});

describe("Just a list and People", () => {
  it("flags the launch's people for a full sync when it moves, and not otherwise", async () => {
    const db = world();
    db.seed("contacts", "ct_sam", { tenantId: "ten_A", memberOf: ["all", "launch:team-spaces", "launches:many"], sortKey: "2026-11-01|ct_sam", needsSync: false });
    db.seed("contacts", "ct_kim", { tenantId: "ten_A", memberOf: ["all", "launch:offline-mode"], sortKey: "2026-11-02|ct_kim", needsSync: false });
    await setIdea(admin, "team-spaces", { justAList: true }, { db });
    expect(db.raw("contacts", "ct_sam")?.needsSync).toBe(true);
    expect(db.raw("contacts", "ct_kim")?.needsSync).toBe(false);

    db.seed("contacts", "ct_sam", { ...db.raw("contacts", "ct_sam"), needsSync: false });
    await setIdea(admin, "team-spaces", { justAList: true, hypothesis: "Still a list." }, { db });
    expect(db.raw("contacts", "ct_sam")?.needsSync).toBe(false);
  });
});
