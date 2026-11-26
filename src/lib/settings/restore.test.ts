import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { readFieldList } from "@/lib/audience/fieldList";
import { importJourneyDocument } from "@/lib/lifecycle/transfer";
import { listSettingsVersions } from "./history";
import { exportFileName, exportHistoryVersion, restoreHistoryVersion } from "./restore";
import { parseHistorySubject } from "./sources";
import { buildWorld, ctx, other, switchesOn, T, type World } from "./testing/world";

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
    expect((await exportHistoryVersion(ctx, { subject: subject(`journey:${w.journeyId}`), rev: 1 }, { db: w.db })).status).toBe(404);
  });
});
