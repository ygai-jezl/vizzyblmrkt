import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { readFieldList } from "@/lib/audience/fieldList";
import { importJourneyDocument } from "@/lib/lifecycle/transfer";
import { listSettingsVersions } from "./history";
import { exportFileName, exportHistoryVersion, restoreHistoryVersion } from "./restore";
import { parseHistorySubject } from "./sources";
import { changeSavedView, listSavedViews, readTeamViews } from "@/lib/views/savedViews";
import { sameView } from "@/lib/views/types";
import { listHistory } from "./sources";
import { addTeamViews, buildWorld, ctx, lookup, member, other, switchesOn, T, viewsOn, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  switchesOn();
  w = await buildWorld();
});
afterEach(() => vi.unstubAllEnvs());

const subject = (s: string) => parseHistorySubject(s)!;
const NAVY = { headerColor: "#0b1f3a", accentColor: "#ff6b35" };

describe("restoreHistoryVersion", () => {
  it("restores a field list as a new version on top, and answers 409 from a stale rev", async () => {
    const r = await restoreHistoryVersion(ctx, { subject: subject("fields:person"), rev: 1, base: 4 }, { db: w.db, nowMs: Date.parse(T(20)) });
    expect(r).toEqual({ status: 200, body: { ok: true, rev: 5, message: "Restored version 1" } });
    expect((await listSettingsVersions(ctx, "fields:person", {}, w.db)).versions[0]).toMatchObject({ rev: 5, source: "restore", restoredFrom: 1, by: { type: "member", id: "usr_maya" } });
    expect((await readFieldList(ctx, "person", w.db)).items.find((f) => f.key === w.tier)!.options!.map((o) => [o.label, o.archivedAt ?? null])).toEqual([
      ["Gold", null],
      ["Silver", null],
      ["Bronze", T(20)],
    ]);
    expect((await restoreHistoryVersion(ctx, { subject: subject("fields:person"), rev: 1, base: 4 }, { db: w.db })).status).toBe(409);
    expect((await restoreHistoryVersion(ctx, { subject: subject("fields:person"), rev: 77, base: 5 }, { db: w.db })).status).toBe(404);
  });

  it("puts a journey version in the draft only: the live version, its style and the people in it stay", async () => {
    const repo = forTenant(ctx, w.db);
    // The journey's style, live and in the draft, which a restore keeps.
    const raw = structuredClone(w.db.raw("lifecycle_journeys", w.journeyId)) as Record<string, unknown> & { draft: { settings: Record<string, unknown> } };
    raw.draft.settings.emailStyle = NAVY;
    raw.emailStyle = NAVY;
    w.db.seed("lifecycle_journeys", w.journeyId, raw);
    await repo.lifecycleEnrolments.create("enr_1", { journeyId: w.journeyId, versionId: `${w.journeyId}_v2`, status: "active" } as never);
    const before = (await repo.lifecycleJourneys.getById(w.journeyId))!;
    const v2Before = await repo.lifecycleVersions.getById(`${w.journeyId}_v2`);

    const stale = await restoreHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1, base: T(1) }, { db: w.db });
    expect(stale).toEqual({ status: 409, body: { error: "draft_changed" } });

    const r = await restoreHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1, base: before.updatedAt }, { db: w.db, nowMs: Date.parse(T(21)) });
    expect(r.status).toBe(200);
    const after = (await repo.lifecycleJourneys.getById(w.journeyId))!;
    const v1 = (await repo.lifecycleVersions.getById(`${w.journeyId}_v1`))!;
    expect(after.draft.graph).toEqual(v1.graph);
    expect(after.draft.pools).toEqual(v1.pools);
    const { emailStyle: style, ...settings } = after.draft.settings as typeof after.draft.settings & { emailStyle?: unknown };
    expect(settings).toEqual(v1.settings);
    expect(style).toEqual(NAVY);
    expect(after).toMatchObject({ publishedVersion: 2, status: before.status, emailStyle: NAVY, authoredBy: "human", draftRestoredFrom: { version: 1, by: "usr_maya", at: T(21) } });
    expect(await repo.lifecycleVersions.getById(`${w.journeyId}_v2`)).toEqual(v2Before);
    expect(await repo.lifecycleEnrolments.getById("enr_1")).toMatchObject({ versionId: `${w.journeyId}_v2`, status: "active" });
  });

  it("restores a catalog through its own writer, and only with catalog history on", async () => {
    const r = await restoreHistoryVersion(ctx, { subject: subject("catalog:pcn_life"), rev: 2, base: 3 }, { db: w.db });
    expect(r).toEqual({ status: 200, body: { ok: true, rev: 4 } });
    expect((await restoreHistoryVersion(ctx, { subject: subject("catalog:pcn_life"), rev: 2, base: 3 }, { db: w.db })).status).toBe(409);
    vi.stubEnv("CATALOG_HISTORY_ENABLED", "false");
    expect(await restoreHistoryVersion(ctx, { subject: subject("catalog:pcn_life"), rev: 2, base: 4 }, { db: w.db })).toEqual({ status: 409, body: { error: "read_only" } });
  });

  it("never restores shared connections, a bad base, or another brand's version", async () => {
    expect(await restoreHistoryVersion(ctx, { subject: subject("connections:shared"), rev: 1, base: 1 }, { db: w.db })).toEqual({ status: 409, body: { error: "read_only" } });
    expect((await restoreHistoryVersion(ctx, { subject: subject("fields:person"), rev: 1, base: "x" }, { db: w.db })).status).toBe(400);
    expect((await restoreHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1, base: 3 }, { db: w.db })).status).toBe(400);
    // The other brand's own list has one version; this brand can't reach it, nor it this one's journey.
    expect((await restoreHistoryVersion(other, { subject: subject(`journey:${w.journeyId}`), rev: 1, base: T(8) }, { db: w.db })).status).toBe(404);
  });
});

describe("exportHistoryVersion", () => {
  it("exports a setting's version as JSON", async () => {
    const r = await exportHistoryVersion(ctx, { subject: subject("fields:person"), rev: 1 }, { db: w.db });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ format: "yougrow.settings-version", formatVersion: 1, subject: "fields:person", rev: 1, savedAt: T(2, 9) });
    expect((r.body as { snapshot: { items: Array<{ label: string }> } }).snapshot.items.map((i) => i.label)).toEqual(["Tier"]);
    expect((await exportHistoryVersion(ctx, { subject: subject("connections:shared"), rev: 1 }, { db: w.db })).status).toBe(200);
    expect(exportFileName(subject("fields:person"), 1)).toBe("people-fields-v1.json");
  });

  it("exports a journey version that imports again as a new draft, and the draft before a restore", async () => {
    const r = await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1 }, { db: w.db });
    expect(r.status).toBe(200);
    const v1 = (await forTenant(ctx, w.db).lifecycleVersions.getById(`${w.journeyId}_v1`))!;
    expect(r.body).toMatchObject({ format: "yougrow.lifecycle-journey", sourceVersion: 1, draft: { graph: v1.graph, pools: v1.pools } });
    const imported = await importJourneyDocument(ctx, { connectionId: "pcn_life", document: r.body }, { db: w.db });
    expect(imported.ok).toBe(true);
    const copy = await forTenant(ctx, w.db).lifecycleJourneys.getById(imported.ok ? imported.value.journeyId : "");
    expect(copy).toMatchObject({ status: "draft", publishedVersion: null });
    expect(copy!.draft.pools).toEqual(v1.pools);
    const draft = await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: "draft" }, { db: w.db });
    expect((draft.body as { draft: { pools: Array<{ items: Array<{ subject: string }> }> } }).draft.pools[0]!.items[0]!.subject).toBe("Unpublished words");
    expect((await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 9 }, { db: w.db })).status).toBe(404);
  });

  it("exports a catalog version, and nothing of an archived journey or a revoked product", async () => {
    const r = await exportHistoryVersion(ctx, { subject: subject("catalog:pcn_life"), rev: 2 }, { db: w.db });
    expect(r.body).toMatchObject({ format: "yougrow.catalog-version", formatVersion: 1, rev: 2, savedAt: T(4) });
    await forTenant(ctx, w.db).productConnections.update("pcn_life", { status: "revoked" });
    expect((await exportHistoryVersion(ctx, { subject: subject("catalog:pcn_life"), rev: 2 }, { db: w.db })).status).toBe(409);
    await forTenant(ctx, w.db).lifecycleJourneys.update(w.journeyId, { status: "archived" });
    expect(await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1 }, { db: w.db })).toEqual({ status: 409, body: { error: "journey_archived" } });
    expect(await exportHistoryVersion(ctx, { subject: subject("journey:lcj_gone"), rev: 1 }, { db: w.db })).toEqual({ status: 404, body: { error: "version_not_found" } });
  });

  it("exports a journey version made before journeys changed shape as it was stored, to read only", async () => {
    // The version the preview refuses to put in the draft, and tells you to export to read.
    await forTenant(ctx, w.db).lifecycleVersions.update(`${w.journeyId}_v1`, { graph: { nodes: "broken" } as never });
    const v1 = (await forTenant(ctx, w.db).lifecycleVersions.getById(`${w.journeyId}_v1`))!;
    const r = await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1 }, { db: w.db });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ format: "yougrow.journey-version", formatVersion: 1, importable: false, name: "Welcome to the greenhouse", version: 1, publishedAt: T(3) });
    expect((r.body as { design: unknown }).design).toEqual({ graph: { nodes: "broken" }, pools: v1.pools, settings: v1.settings });
    // It is never a journey document, so it can't be imported as one.
    expect((await importJourneyDocument(ctx, { connectionId: "pcn_life", document: r.body }, { db: w.db })).ok).toBe(false);
  });
});

describe("team views in History", () => {
  it("restores one view as a version had it, as a new version on top, and leaves the others as they are", async () => {
    const v = await addTeamViews(w);
    viewsOn();
    const r = await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 1, base: 4 }, { db: w.db, nowMs: Date.parse(T(20)) });
    expect(r).toEqual({ status: 200, body: { ok: true, rev: 5, message: "Restored ‘Wholesale’ as it was in version 1" } });
    const newest = (await listSettingsVersions(ctx, "views:person", {}, w.db)).versions[0]!;
    expect(newest).toMatchObject({ rev: 5, source: "restore", restoredFrom: 1, by: { type: "member", id: "usr_maya" } });
    expect(newest.items.map((i) => [i.key, i.change])).toEqual([[v.trade, "changed"]]);
    const team = await readTeamViews(ctx, w.db);
    const trade = team.items.find((x) => x.key === v.trade)!;
    expect(trade).toMatchObject({ label: "Wholesale", version: 3, changedAt: T(20), changedBy: "usr_maya", archivedAt: null });
    expect(sameView(trade.definition, v.gold1)).toBe(true);
    // Gold tier, archived in version 4, stays as it is.
    expect(team.items.find((x) => x.key === v.gold)).toMatchObject({ label: "Gold tier", version: 2, archivedAt: T(14) });
    // A copy of the view opened before the restore can't undo it.
    const fields = (await readFieldList(ctx, "person", w.db)).items;
    expect(await changeSavedView(ctx, v.trade, { version: 2, name: "Stale", fields }, w.db)).toEqual({ ok: false, error: "view_changed" });
    // History says what the restore did, in the saver's words.
    const listed = await listHistory(ctx, { subject: "views:person", limit: 1 }, { db: w.db, lookup });
    expect(listed.ok && listed.page.entries[0]).toMatchObject({ rev: 5, message: "Restored ‘Wholesale’ as it was in version 1", items: ["Changed ‘Wholesale’"], restoredFrom: 1 });
  });

  it("brings an archived view back from the version that had it in use, and answers 409 from a stale rev", async () => {
    const v = await addTeamViews(w);
    viewsOn();
    expect(await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 3, base: 3 }, { db: w.db })).toEqual({ status: 409, body: { error: "views_changed" } });
    const r = await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 3, base: 4 }, { db: w.db, nowMs: Date.parse(T(20)) });
    expect(r).toEqual({ status: 200, body: { ok: true, rev: 5, message: "Restored ‘Gold tier’ as it was in version 3" } });
    expect((await listSavedViews(member, {}, w.db)).team.map((x) => x.name)).toEqual(["Trade buyers", "Gold tier"]);
    expect((await readTeamViews(ctx, w.db)).items.find((x) => x.key === v.gold)).toMatchObject({ archivedAt: null, archivedBy: null, version: 3 });
    // Restoring the version that archived it archives it again.
    expect((await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 4, base: 5 }, { db: w.db, nowMs: Date.parse(T(21)) })).body).toMatchObject({ ok: true, rev: 6 });
    expect((await readTeamViews(ctx, w.db)).items.find((x) => x.key === v.gold)).toMatchObject({ archivedAt: T(21), archivedBy: "usr_maya" });
  });

  it("is for admins, while views are on, and never reaches another brand's views", async () => {
    await addTeamViews(w);
    viewsOn();
    expect(await restoreHistoryVersion(member, { subject: subject("views:person"), rev: 1, base: 4 }, { db: w.db })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await restoreHistoryVersion(other, { subject: subject("views:person"), rev: 1, base: 0 }, { db: w.db })).toEqual({ status: 404, body: { error: "version_not_found" } });
    expect((await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 1, base: "x" }, { db: w.db })).status).toBe(400);
    vi.stubEnv("CRM_VIEWS_ENABLED", "false");
    expect(await restoreHistoryVersion(ctx, { subject: subject("views:person"), rev: 1, base: 4 }, { db: w.db })).toEqual({ status: 409, body: { error: "read_only" } });
    expect((await listSettingsVersions(ctx, "views:person", {}, w.db)).versions.length).toBe(4);
  });

  it("exports a team views version as a settings version, with nobody's own views", async () => {
    await addTeamViews(w);
    viewsOn();
    const r = await exportHistoryVersion(ctx, { subject: subject("views:person"), rev: 3 }, { db: w.db });
    expect(r.body).toMatchObject({ format: "yougrow.settings-version", formatVersion: 1, subject: "views:person", rev: 3, savedAt: T(13) });
    expect((r.body as { snapshot: { items: Array<{ label: string }> } }).snapshot.items.map((i) => i.label)).toEqual(["Trade buyers", "Gold tier"]);
    expect(JSON.stringify(r.body)).not.toContain("My repots");
    expect(exportFileName(subject("views:person"), 3)).toBe("team-views-v3.json");
  });
});
