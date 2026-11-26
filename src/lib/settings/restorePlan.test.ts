import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { readFieldList, restoreFieldListVersion, saveFieldEraseMark, saveFieldListChange } from "@/lib/audience/fieldList";
import { commitSettingsChange, settingsVersionId } from "@/lib/tenant";
import type { SavedView } from "@/lib/types/savedView";
import { readTeamViews } from "@/lib/views/savedViews";
import { NEVER_UNDONE, previewRestore, type RestorePreview } from "./restorePlan";
import { parseHistorySubject } from "./sources";
import { addTeamViews, buildWorld, ctx, lookup, switchesOn, T, TENANT_ID, viewsOn, type World } from "./testing/world";
import { TEAM_VIEWS_FULL_TEXT } from "./words";

let w: World;
beforeEach(async () => {
  switchesOn();
  w = await buildWorld();
});
afterEach(() => vi.unstubAllEnvs());

async function preview(subject: string, rev: number): Promise<RestorePreview> {
  const r = await previewRestore(ctx, parseHistorySubject(subject)!, rev, { db: w.db, lookup, nowIso: T(20) });
  if (!r.ok) throw new Error(r.error);
  return r.preview;
}
const rows = (p: RestorePreview) => Object.fromEntries(p.rows.map((r) => [r.label, r.lines]));

describe("previewRestore: a field list", () => {
  it("says what changes back, as the restore will save it, on top of the version there now", async () => {
    const p = await preview("fields:person", 1);
    expect(p).toMatchObject({ title: "Restore People fields to version 1?", savedBy: "Maya Chen", savedAt: T(2, 9), becomes: 5, currentRev: 4, base: 4, refused: null });
    expect(rows(p)).toEqual({
      "Changes back": ["‘Tier’ options: Gold, Silver. ‘Bronze’ is archived."],
      "Never undone": [NEVER_UNDONE],
    });
  });

  it("lists what comes back and what is archived", async () => {
    // Bring Delivery day back, so version 1 (which didn't have it) archives it and version 2 brings nothing back.
    await saveFieldListChange(ctx, "person", { baseRev: 4, change: { op: "restore", key: "fld_000000000002" }, by: { type: "member", id: "usr_maya" }, nowIso: T(10) }, w.db);
    expect(rows(await preview("fields:person", 1))["Archived"]).toEqual(["‘Delivery day’: hidden and read only, its values kept"]);
    await saveFieldListChange(ctx, "person", { baseRev: 5, change: { op: "archive", key: "fld_000000000002" }, by: { type: "member", id: "usr_maya" }, nowIso: T(11) }, w.db);
    expect(rows(await preview("fields:person", 2))["Comes back"]).toEqual(["‘Delivery day’, with the values people already have"]);
  });
});

describe("previewRestore: an erased field", () => {
  it("says an erased field comes back empty, and when erase is on that an archive starts its 30 days", async () => {
    // Delivery day (archived in v4) had its values erased; v2 had it in use.
    const list = await readFieldList(ctx, "person", w.db);
    const items = list.items.map((f) => (f.key === "fld_000000000002" ? { ...f, erasedAt: T(10), erasedBy: "usr_priya" } : f));
    await commitSettingsChange(ctx, { subject: "fields:person", baseRev: list.rev, value: { items }, by: { type: "member", id: "usr_priya" }, source: "erase", message: "Erased the values of ‘Delivery day’", nowIso: T(10) }, w.db);
    const p = await preview("fields:person", 2);
    expect(rows(p)["Stays empty"]).toEqual(["‘Delivery day’: its values were erased on 10 Nov"]);
    expect(rows(p)).not.toHaveProperty("Comes back");
    // Back in use, then a restore of v1 archives it: its 30 days start again, said while erasing is on.
    await saveFieldListChange(ctx, "person", { baseRev: list.rev + 1, change: { op: "restore", key: "fld_000000000002" }, by: { type: "member", id: "usr_maya" }, nowIso: T(11) }, w.db);
    expect((await preview("fields:person", 1)).rows.find((r) => r.label === "Archived")!.note).toBeUndefined();
    for (const n of ["PLANS_ENABLED", "SETTINGS_ERASE_ENABLED"]) vi.stubEnv(n, "true");
    expect((await preview("fields:person", 1)).rows.find((r) => r.label === "Archived")!.note).toBe("Its 30 days before anyone can erase its values start today.");
  });

  it("says a field whose values are being erased stays archived, as the restore saves it", async () => {
    const maya = { type: "member", id: "usr_maya" } as const;
    const marked = await saveFieldEraseMark(ctx, "person", { key: "fld_000000000002", step: "start", by: "usr_priya", nowIso: T(10) }, w.db);
    expect(marked.ok).toBe(true);
    const p = await preview("fields:person", 2);
    expect(rows(p)["Stays archived"]).toEqual(["‘Delivery day’: its values are being erased"]);
    expect(rows(p)).not.toHaveProperty("Comes back");
    // The restore itself keeps it archived and marked.
    const list = await readFieldList(ctx, "person", w.db);
    expect((await restoreFieldListVersion(ctx, "person", { rev: 2, baseRev: list.rev, by: maya, nowIso: T(20) }, w.db)).ok).toBe(true);
    expect((await readFieldList(ctx, "person", w.db)).items.find((f) => f.key === "fld_000000000002")).toMatchObject({ archivedAt: T(9), erasingSince: T(10) });
  });

  it("says a field erased once, then brought back, filled in and archived again, comes back with its values", async () => {
    const maya = { type: "member", id: "usr_maya" } as const;
    await saveFieldEraseMark(ctx, "person", { key: "fld_000000000002", step: "start", by: "usr_priya", nowIso: T(10, 9) }, w.db);
    await saveFieldEraseMark(ctx, "person", { key: "fld_000000000002", step: "done", by: "usr_priya", nowIso: T(10, 11) }, w.db);
    let list = await readFieldList(ctx, "person", w.db);
    await saveFieldListChange(ctx, "person", { baseRev: list.rev, change: { op: "restore", key: "fld_000000000002" }, by: maya, nowIso: T(11) }, w.db);
    list = await readFieldList(ctx, "person", w.db);
    await saveFieldListChange(ctx, "person", { baseRev: list.rev, change: { op: "archive", key: "fld_000000000002" }, by: maya, nowIso: T(12) }, w.db);
    const p = await preview("fields:person", 2);
    expect(rows(p)["Comes back"]).toEqual(["‘Delivery day’, with the values people already have"]);
    expect(rows(p)).not.toHaveProperty("Stays empty");
  });
});

describe("previewRestore: a journey", () => {
  it("fills the draft only: the live version, its people and its style stay, and unpublished edits are named", async () => {
    for (const id of ["e1", "e2"]) {
      await forTenant(ctx, w.db).lifecycleEnrolments.create(id, { journeyId: w.journeyId, versionId: `${w.journeyId}_v2`, status: "active" } as never);
    }
    const p = await preview(`journey:${w.journeyId}`, 1);
    const journey = (await forTenant(ctx, w.db).lifecycleJourneys.getById(w.journeyId))!;
    expect(p).toMatchObject({
      title: "Put version 1 of ‘Welcome to the greenhouse’ in the draft?",
      savedBy: "Former team member",
      savedAt: T(3),
      becomes: null,
      currentRev: 2,
      unpublishedSince: journey.updatedAt,
      issues: [],
      refused: null,
      base: journey.updatedAt,
      footnote: "Nothing goes live until someone presses Publish. The new version then says it came from version 1.",
    });
    expect(rows(p)).toEqual({
      "The draft": ["Becomes version 1: its steps, emails, waits and settings."],
      "Stays as it is": ["The live version 2 and the 2 people in this journey now", "The journey's email style"],
      "Never undone": [NEVER_UNDONE],
    });
  });

  it("names nothing unpublished when the draft is the live version, and lists what to fix against today's catalog", async () => {
    const journey = (await forTenant(ctx, w.db).lifecycleJourneys.getById(w.journeyId))!;
    const live = (await forTenant(ctx, w.db).lifecycleVersions.getById(`${w.journeyId}_v2`))!;
    await forTenant(ctx, w.db).lifecycleJourneys.update(w.journeyId, { draft: { ...journey.draft, graph: live.graph, pools: live.pools, settings: live.settings } });
    expect((await preview(`journey:${w.journeyId}`, 1)).unpublishedSince).toBeNull();
    // The product no longer has its onboarding steps: version 1 still goes in the draft, with what to fix.
    const conn = (await forTenant(ctx, w.db).productConnections.getById("pcn_life"))!;
    await forTenant(ctx, w.db).productConnections.update("pcn_life", { catalog: { ...conn.catalog, onboardingSteps: [] } });
    const p = await preview(`journey:${w.journeyId}`, 1);
    expect(p.issues.length).toBeGreaterThan(0);
    expect(p.refused).toBeNull();
  });

  it("refuses a version today's draft check can't read, and an archived journey, saying why", async () => {
    await forTenant(ctx, w.db).lifecycleVersions.update(`${w.journeyId}_v1`, { graph: { nodes: "broken" } as never });
    let p = await preview(`journey:${w.journeyId}`, 1);
    expect(p.refused).toBe("Version 1 was made before journeys changed shape, so it can't be put in the draft. Export it to read it.");
    expect(p.base).toBeNull();
    await forTenant(ctx, w.db).lifecycleJourneys.update(w.journeyId, { status: "archived" });
    p = await preview(`journey:${w.journeyId}`, 2);
    expect(p.refused).toBe("Journey ‘Welcome to the greenhouse’ is archived, so its versions are read only.");
  });
});

describe("previewRestore: a catalog", () => {
  it("says what changes back and that stages are read with it from now on", async () => {
    const p = await preview("catalog:pcn_life", 2);
    expect(p).toMatchObject({ title: "Restore Product catalog ‘Sandbox’ to version 2?", savedBy: "Former team member", becomes: 4, currentRev: 3, base: 3, refused: null });
    expect(rows(p)).toEqual({
      "Changes back": ["Renamed step ‘First visit’ to ‘Run an audit’"],
      "From now on": ["Stages in this product are read with this catalog."],
      "Never undone": [NEVER_UNDONE],
    });
    // Version 1, from before history, didn't have the booking step: the step added since is removed.
    const v1 = await preview("catalog:pcn_life", 1);
    expect(v1.savedBy).toBe("YouGrow");
    expect(rows(v1)["Changes back"]).toEqual(["Renamed step ‘First visit’ to ‘Run an audit’", "Removed step ‘Book a visit’"]);
  });

  it("has no restore with catalog history off, or for a revoked product", async () => {
    vi.stubEnv("CATALOG_HISTORY_ENABLED", "false");
    expect((await preview("catalog:pcn_life", 2)).refused).toBe("Restoring a catalog isn't switched on in this copy of YouGrow.");
    vi.stubEnv("CATALOG_HISTORY_ENABLED", "true");
    await forTenant(ctx, w.db).productConnections.update("pcn_life", { status: "revoked" });
    expect(await preview("catalog:pcn_life", 2)).toMatchObject({ refused: "This product's connection is revoked, so its catalog is read only.", base: null });
  });
});

describe("previewRestore: what has none", () => {
  it("leaves shared connections read only, and finds no version that isn't there", async () => {
    expect(await previewRestore(ctx, parseHistorySubject("connections:shared")!, 1, { db: w.db })).toEqual({ ok: false, status: 409, error: "read_only" });
    expect(await previewRestore(ctx, parseHistorySubject("fields:person")!, 99, { db: w.db })).toEqual({ ok: false, status: 404, error: "version_not_found" });
    expect(await previewRestore(ctx, parseHistorySubject(`journey:${w.journeyId}`)!, 9, { db: w.db })).toEqual({ ok: false, status: 404, error: "version_not_found" });
  });
});

describe("previewRestore: team views, one view at a time", () => {
  const STAYS = ["Every other team view", "Everyone's Only me views"];

  it("puts back only the view the version names, as that version had it", async () => {
    await addTeamViews(w);
    viewsOn();
    // Version 1 saved Wholesale; it has been renamed Trade buyers and given Silver since. Gold tier stays archived.
    const p = await preview("views:person", 1);
    expect(p).toMatchObject({ kind: "views", title: "Restore team view ‘Wholesale’ to version 1?", savedBy: "Maya Chen", savedAt: T(11), becomes: 5, currentRev: 4, base: 4, refused: null });
    expect(rows(p)).toEqual({
      "Changes back": ["‘Trade buyers’ renamed back to ‘Wholesale’. ‘Wholesale’: its filters, columns and sort as version 1 had them"],
      "Stays as it is": STAYS,
      "Never undone": [NEVER_UNDONE],
    });
    // Version 3 had Gold tier in use: it comes back, and nothing about Trade buyers changes.
    expect(rows(await preview("views:person", 3))).toEqual({
      "Comes back": ["‘Gold tier’, in the Views menu for everyone on the team"],
      "Stays as it is": STAYS,
      "Never undone": [NEVER_UNDONE],
    });
  });

  it("has nothing to restore from a version that is how the view is now", async () => {
    await addTeamViews(w);
    viewsOn();
    const p = await preview("views:person", 4);
    expect(p).toMatchObject({ refused: "‘Gold tier’ is already as version 4 had it, so there is nothing to restore.", base: null });
    expect(rows(p)["Changes back"]).toEqual(["Nothing: ‘Gold tier’ is as this version had it"]);
  });

  it("refuses a view that would go over 50 in use, or that doesn't fit today's views", async () => {
    await addTeamViews(w);
    viewsOn();
    const team = await readTeamViews(ctx, w.db);
    const more: SavedView[] = Array.from({ length: 49 }, (_, i) => ({ ...team.items[0]!, key: `viw_more${String(i).padStart(8, "0")}`, label: `View ${i}`, version: 1 }));
    await commitSettingsChange(ctx, { subject: "views:person", baseRev: team.rev, value: { items: [...team.items, ...more] }, by: { type: "member", id: "usr_maya" }, source: "editor", nowIso: T(16) }, w.db);
    expect(await preview("views:person", 3)).toMatchObject({ refused: TEAM_VIEWS_FULL_TEXT, base: null });
    // A filter on typed words is never saved; a version holding one is read only here.
    const id = settingsVersionId(TENANT_ID, "views:person", 1);
    const v1 = structuredClone(w.db.raw("settings_versions", id)) as { snapshot: { items: Array<{ definition: { filters: unknown[] } }> } };
    v1.snapshot.items[0]!.definition.filters = [{ on: "email_domain", op: "contains", value: "example.com" }];
    w.db.seed("settings_versions", id, v1);
    expect(await preview("views:person", 1)).toMatchObject({ refused: "Version 1 of ‘Wholesale’ doesn't fit today's views, so it can't be restored. Export it to read it.", base: null });
  });

  it("is read only while views are off", async () => {
    await addTeamViews(w);
    expect(await previewRestore(ctx, parseHistorySubject("views:person")!, 1, { db: w.db })).toEqual({ ok: false, status: 409, error: "read_only" });
  });
});
