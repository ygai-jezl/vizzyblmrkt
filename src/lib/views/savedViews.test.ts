import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { commitMemberViews, commitSettingsChange, forTenant, memberViewsDocId, readMemberViews, settingsDocId } from "@/lib/tenant";
import { TenantIsolationError } from "@/lib/tenant/errors";
import type { TenantContext } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import { SAVED_VIEW_LIMITS, type SavedView } from "@/lib/types/savedView";
import { changeSavedView, createSavedView, findSavedView, listSavedViews, removeSavedView, restoreTeamView, TEAM_VIEWS_SUBJECT } from "./savedViews";
import { emptyView, type ViewDefinition } from "./types";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const admin2: TenantContext = { ...admin, userId: "u_admin2" };
const member: TenantContext = { ...admin, userId: "u_member", role: "member" };
const member2: TenantContext = { ...admin, userId: "u_member2", role: "member" };
const otherBrand: TenantContext = { ...admin, tenantId: "ten_B" };

const at = "2026-11-01T00:00:00.000Z";
const TYPE = {
  key: "fld_type00000001",
  label: "Customer type",
  type: "select",
  object: "person",
  options: [{ id: "opt_whole001", label: "Wholesale" }],
  archivedAt: null,
  createdAt: at,
  createdBy: null,
} as RecordField;
const NOTES = { key: "fld_notes0000001", label: "Notes", type: "text", object: "person", archivedAt: null, createdAt: at, createdBy: null } as RecordField;
const FIELDS = [TYPE, NOTES];

const WHOLESALE: ViewDefinition = {
  ...emptyView(),
  filters: [
    { on: TYPE.key, op: "any_of", value: ["opt_whole001"] },
    { on: "last_active", op: "in_last", value: 60 },
  ],
  sort: { by: "last_active", dir: "desc" },
};

let db: FakeFirestore;
let ids = 0;
const newId = () => `viw_${String(++ids).padStart(12, "0")}`;
const create = (ctx: TenantContext, scope: "team" | "me", name: string, definition: unknown = WHOLESALE) =>
  createSavedView(ctx, { scope, name, definition, fields: FIELDS, newId, nowIso: "2026-11-26T10:00:00.000Z" }, db);
const versions = () => forTenant(admin, db).settingsVersions.find({ where: [["subject", "==", TEAM_VIEWS_SUBJECT]] });

beforeEach(() => {
  db = new FakeFirestore();
  ids = 0;
});

describe("team views", () => {
  it("are saved by admins, one settings version per save holding the whole list", async () => {
    const a = await create(admin, "team", " Wholesale, ordered lately ");
    expect(a).toMatchObject({ ok: true, view: { id: "viw_000000000001", scope: "team", name: "Wholesale, ordered lately", version: 1, archived: false, changedBy: "u_admin" } });
    await create(admin2, "team", "Next repot due", emptyView());
    const v = await versions();
    expect(v.map((x) => x.rev).sort()).toEqual([1, 2]);
    const second = v.find((x) => x.rev === 2)!;
    expect(second).toMatchObject({ subject: "views:person", source: "editor", by: { type: "member", id: "u_admin2" }, message: "Saved team view ‘Next repot due’" });
    expect(second.snapshot.items.map((i) => i.label)).toEqual(["Wholesale, ordered lately", "Next repot due"]);
    expect(second.items).toEqual([expect.objectContaining({ key: "viw_000000000002", change: "added" })]);
    // A member sees them, by name, for opening.
    expect((await listSavedViews(member, {}, db)).team.map((x) => x.name)).toEqual(["Wholesale, ordered lately", "Next repot due"]);
  });

  it("are for admins only: a member can't save, change or archive one", async () => {
    expect(await create(member, "team", "Mine")).toEqual({ ok: false, error: "admins_only" });
    const a = await create(admin, "team", "Wholesale");
    const id = a.ok ? a.view.id : "";
    expect(await changeSavedView(member, id, { version: 1, name: "Renamed", fields: FIELDS }, db)).toEqual({ ok: false, error: "admins_only" });
    expect(await removeSavedView(member, id, { version: 1 }, db)).toEqual({ ok: false, error: "admins_only" });
    expect(await restoreTeamView(member, id, {}, db)).toEqual({ ok: false, error: "admins_only" });
    expect((await versions()).length).toBe(1);
  });

  it("are archived, never removed, and come back", async () => {
    const a = await create(admin, "team", "Wholesale");
    const id = a.ok ? a.view.id : "";
    const gone = await removeSavedView(admin, id, { version: 1 }, db);
    expect(gone).toMatchObject({ ok: true, view: { archived: true, version: 2 } });
    expect((await listSavedViews(admin, {}, db)).team).toEqual([]);
    expect((await listSavedViews(admin, { archived: true }, db)).team).toEqual([expect.objectContaining({ id, archived: true })]);
    // Members can't open an archived one; admins can, to bring it back.
    expect(await findSavedView(member, id, db)).toBeNull();
    expect(await findSavedView(admin, id, db)).toMatchObject({ id, archived: true });
    // An archived view isn't changed until it is back.
    expect(await changeSavedView(admin, id, { version: 2, name: "X", fields: FIELDS }, db)).toEqual({ ok: false, error: "view_not_found" });
    expect(await restoreTeamView(admin, id, {}, db)).toMatchObject({ ok: true, view: { archived: false, version: 3 } });
    const v = await versions();
    expect(v.map((x) => x.items[0]?.change).sort()).toEqual(["added", "archived", "restored"]);
    expect(v.every((x) => x.snapshot.items.length === 1)).toBe(true);
  });

  it("retry when another save moved the list on, and refuse a view changed since it was opened", async () => {
    const a = await create(admin, "team", "Wholesale");
    const id = a.ok ? a.view.id : "";
    // Someone else saves a view between this save's read and its write, `times` times.
    const transact = db.runTransaction.bind(db);
    const plain = { collection: db.collection.bind(db), runTransaction: transact } as unknown as FakeFirestore;
    let raced = 0;
    const racing = (times: number) => {
      let bumps = 0;
      const spy = vi.spyOn(db, "runTransaction").mockImplementation(async (fn) => {
        if (bumps < times) {
          bumps += 1;
          raced += 1;
          const doc = db.raw("saved_views", settingsDocId("ten_A", TEAM_VIEWS_SUBJECT));
          const items = (doc?.items ?? []) as SavedView[];
          const extra = { ...items[0]!, key: `viw_race0000000${raced}`, label: `Race ${raced}` };
          await commitSettingsChange(admin2, { subject: TEAM_VIEWS_SUBJECT, baseRev: (doc?.rev ?? 0) as number, value: { items: [...items, extra] }, by: { type: "member", id: "u_admin2" }, source: "editor" }, plain);
        }
        return transact(fn);
      });
      return spy;
    };
    let spy = racing(1);
    const renamed = await changeSavedView(admin, id, { version: 1, name: "Wholesale buyers", fields: FIELDS }, db);
    spy.mockRestore();
    expect(renamed).toMatchObject({ ok: true, view: { name: "Wholesale buyers", version: 2 } });
    expect((await listSavedViews(admin, {}, db)).team.map((x) => x.name)).toEqual(["Wholesale buyers", "Race 1"]);
    // The view itself changed since it was opened at version 1.
    expect(await changeSavedView(admin2, id, { version: 1, name: "Stale", fields: FIELDS }, db)).toEqual({ ok: false, error: "view_changed" });
    // A list that keeps moving: three tries, then it says so.
    spy = racing(3);
    expect(await changeSavedView(admin, id, { version: 2, name: "Again", fields: FIELDS }, db)).toEqual({ ok: false, error: "views_changed" });
    spy.mockRestore();
  });

  it("keep to their caps: 50 in use, 200 in all, one view under 2 KB", async () => {
    for (let i = 0; i < SAVED_VIEW_LIMITS.teamInUse; i++) expect((await create(admin, "team", `View ${i}`, emptyView())).ok).toBe(true);
    expect(await create(admin, "team", "One more", emptyView())).toEqual({ ok: false, error: "team_views_full" });
    expect((await removeSavedView(admin, "viw_000000000001", { version: 1 }, db)).ok).toBe(true);
    expect((await create(admin, "team", "One more", emptyView())).ok).toBe(true);
    // Bringing one back past 50 in use is refused too.
    expect(await restoreTeamView(admin, "viw_000000000001", {}, db)).toEqual({ ok: false, error: "team_views_full" });

    // 200 in all, archived ones included.
    db = new FakeFirestore();
    const items = Array.from({ length: SAVED_VIEW_LIMITS.teamTotal }, (_, i) => ({
      key: `viw_${String(i).padStart(12, "a")}`,
      label: `Old ${i}`,
      definition: emptyView(),
      version: 1,
      createdAt: at,
      createdBy: null,
      changedAt: at,
      changedBy: null,
      archivedAt: at,
      archivedBy: null,
    }));
    await commitSettingsChange(admin, { subject: TEAM_VIEWS_SUBJECT, baseRev: 0, value: { items }, by: { type: "member", id: "u_admin" }, source: "editor" }, db);
    expect(await create(admin, "team", "Two hundred and one", emptyView())).toEqual({ ok: false, error: "team_views_full" });

    // One view under 2 KB.
    const big: ViewDefinition = {
      ...emptyView(),
      filters: Array.from({ length: 3 }, (_, f) => ({ on: "launch", op: "any_of" as const, value: Array.from({ length: 20 }, (_, i) => `launch_${f}_${String(i).padStart(30, "x")}`) })),
    };
    expect(await create(admin2, "me", "Too big", big)).toEqual({ ok: false, error: "view_too_large" });
  });
});

describe("what a saved view keeps", () => {
  it("never keeps typed words, and names the filters that hold them", async () => {
    const typed: ViewDefinition = {
      ...emptyView(),
      filters: [
        { on: "last_active", op: "in_last", value: 60 },
        { on: "email_domain", op: "equals", value: "greenroom-cafe.example" },
      ],
    };
    expect(await create(admin, "team", "Domain", typed)).toEqual({ ok: false, error: "typed_words", filters: [1] });
    expect(await create(member, "me", "Domain", typed)).toEqual({ ok: false, error: "typed_words", filters: [1] });
    expect(await create(admin, "team", "Notes", { ...emptyView(), filters: [{ on: NOTES.key, op: "contains", value: "repot" }] })).toMatchObject({ error: "typed_words" });
    expect(await create(admin, "team", "", emptyView())).toEqual({ ok: false, error: "invalid_name" });
    expect(await create(admin, "team", "x".repeat(61), emptyView())).toEqual({ ok: false, error: "invalid_name" });
    expect(await create(admin, "team", "Bad", { ...emptyView(), filters: [{ on: TYPE.key, op: "any_of", value: ["opt_missing1"] }] })).toEqual({ ok: false, error: "invalid_view" });
    expect(await versions()).toEqual([]);
  });
});

describe("Only me views", () => {
  it("are saved by anyone, never logged, and seen only by their maker", async () => {
    const mine = await create(member, "me", "My callbacks this week");
    expect(mine).toMatchObject({ ok: true, view: { scope: "me", name: "My callbacks this week", changedBy: null } });
    const id = mine.ok ? mine.view.id : "";
    expect(await versions()).toEqual([]);
    expect((await listSavedViews(member, {}, db)).mine.map((v) => v.name)).toEqual(["My callbacks this week"]);
    expect((await listSavedViews(member2, {}, db)).mine).toEqual([]);
    expect((await listSavedViews(admin, {}, db)).mine).toEqual([]);
    expect(await findSavedView(member2, id, db)).toBeNull();
    expect(await changeSavedView(member2, id, { version: 1, name: "Taken", fields: FIELDS }, db)).toEqual({ ok: false, error: "view_not_found" });
    expect(await removeSavedView(admin, id, { version: 1 }, db)).toEqual({ ok: false, error: "view_not_found" });
    // Changed by their maker, then deleted for real.
    expect(await changeSavedView(member, id, { version: 1, definition: emptyView(), fields: FIELDS }, db)).toMatchObject({ ok: true, view: { version: 2 } });
    expect(await changeSavedView(member, id, { version: 1, name: "Stale", fields: FIELDS }, db)).toEqual({ ok: false, error: "view_changed" });
    expect(await removeSavedView(member, id, { version: 2 }, db)).toMatchObject({ ok: true });
    expect((await readMemberViews(member, db)).views).toEqual([]);
    expect(await versions()).toEqual([]);
  });

  it("keep to 50 a member", async () => {
    for (let i = 0; i < SAVED_VIEW_LIMITS.mine; i++) expect((await create(member, "me", `Mine ${i}`, emptyView())).ok).toBe(true);
    expect(await create(member, "me", "One more", emptyView())).toEqual({ ok: false, error: "my_views_full" });
    expect((await create(member2, "me", "Someone else's first", emptyView())).ok).toBe(true);
  });

  it("read back the same from a database that keeps dates as Firestore does", async () => {
    db = timestampFirestore(new FakeFirestore());
    expect((await create(member, "me", "Mine")).ok).toBe(true);
    expect((await create(admin, "team", "Team")).ok).toBe(true);
    const views = await listSavedViews(member, {}, db);
    expect(views.mine[0]).toMatchObject({ name: "Mine", changedAt: "2026-11-26T10:00:00.000Z" });
    expect(views.team[0]).toMatchObject({ name: "Team", changedAt: "2026-11-26T10:00:00.000Z" });
  });
});

describe("another brand", () => {
  it("reads as none, and is never written over", async () => {
    // Documents under this brand's ids that belong to another brand.
    db.seed("saved_views", settingsDocId("ten_A", TEAM_VIEWS_SUBJECT), { tenantId: "ten_B", subject: TEAM_VIEWS_SUBJECT, rev: 1, items: [{ key: "viw_theirs000001", label: "Theirs" }] });
    db.seed("member_views", memberViewsDocId("ten_A", "u_member"), { tenantId: "ten_B", userId: "u_member", rev: 1, views: [{ key: "viw_theirs000002", label: "Theirs" }] });
    expect(await listSavedViews(admin, { archived: true }, db)).toEqual({ team: [], mine: [] });
    expect(await listSavedViews(member, {}, db)).toEqual({ team: [], mine: [] });
    await expect(create(member, "me", "Mine")).rejects.toThrow(TenantIsolationError);
    await expect(commitMemberViews(member, { baseRev: 0, views: [] }, db)).rejects.toThrow(TenantIsolationError);
    // Their own lists stay theirs.
    expect((await create(otherBrand, "team", "Ours")).ok).toBe(true);
    expect((await listSavedViews(admin, {}, db)).team).toEqual([]);
  });
});
