import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { FIELD_LIST_STATUS, restoreFieldListVersion } from "@/lib/audience/fieldList";
import { restoreCatalogVersion } from "@/lib/connect/adminApi";
import { getCatalogRevision } from "@/lib/connect/catalogHistory";
import { versionDocId } from "@/lib/lifecycle/enrol";
import { saveLifecycleDraft } from "@/lib/lifecycle/service";
import { exportJourneyDocument } from "@/lib/lifecycle/transfer";
import type { SettingsSubject } from "@/lib/types/settingsVersion";
import { restoreTeamViewsVersion, TEAM_VIEWS_SUBJECT, type TeamViewsRestoreError } from "@/lib/views/savedViews";
import { getSettingsVersion } from "./history";
import { kindRestores, type HistorySubject } from "./sources";

/**
 * Restoring and exporting a version from Settings › History (ADR-0023), for the brand in the
 * context. Each restore goes through the kind's own writer, from the base the preview showed, so a
 * stale one answers 409 and writes nothing:
 * - a field list through restoreFieldListVersion: a new version on top, fields it didn't have
 *   archived (from now), so it can be undone too;
 * - a journey through saveLifecycleDraft, into the draft only, by a person, keeping the journey's
 *   email style and stamping the version it came from; the live version and its people stay;
 * - a catalog through restoreCatalogVersion (CATALOG_HISTORY_ENABLED), which stages are read with
 *   from then on;
 * - team views through restoreTeamViewsVersion, one view at a time: the views the version names go
 *   back as it had them, as a new version on top, and every other team view stays as it is.
 * Shared connections are read only here. Exports are JSON, with no one's personal data.
 */

export type ApiResult = { status: number; body: unknown };

export const SETTINGS_VERSION_FORMAT = "yougrow.settings-version";
export const CATALOG_VERSION_FORMAT = "yougrow.catalog-version";
/** A journey version today's draft can't hold, exported to read only. */
export const JOURNEY_VERSION_FORMAT = "yougrow.journey-version";

/** Each team views restore error's status: a save in between (or a list now full) answers 409. */
const VIEWS_RESTORE_STATUS: Record<TeamViewsRestoreError, number> = {
  admins_only: 403,
  views_changed: 409,
  version_not_found: 404,
  view_old_shape: 409,
  nothing_to_restore: 409,
  team_views_full: 409,
};

const fieldObject = (subject: SettingsSubject) => (subject === "fields:person" ? "person" : subject === "fields:company" ? "company" : null);

/** Restore `rev` of a subject from `base` (the rev, or a journey's updatedAt, the preview showed). */
export async function restoreHistoryVersion(
  ctx: TenantContext,
  input: { subject: HistorySubject; rev: number; base: number | string },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ApiResult> {
  const { subject, rev, base } = input;
  if (!kindRestores(subject.kind)) return { status: 409, body: { error: "read_only" } };
  if (!Number.isInteger(rev) || rev < 0) return { status: 400, body: { error: "invalid_input" } };
  if (subject.store === "settings" && subject.subject === TEAM_VIEWS_SUBJECT) {
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0) return { status: 400, body: { error: "invalid_input" } };
    const r = await restoreTeamViewsVersion(ctx, { rev, baseRev: base, ...(deps.nowMs ? { nowIso: new Date(deps.nowMs).toISOString() } : {}) }, deps.db);
    if (!r.ok) return { status: VIEWS_RESTORE_STATUS[r.error], body: { error: r.error === "admins_only" ? "forbidden" : r.error } };
    return { status: 200, body: { ok: true, rev: r.rev, message: r.message } };
  }
  if (subject.store === "settings") {
    const object = fieldObject(subject.subject);
    if (!object) return { status: 409, body: { error: "read_only" } };
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0) return { status: 400, body: { error: "invalid_input" } };
    const r = await restoreFieldListVersion(
      ctx,
      object,
      { rev, baseRev: base, by: { type: "member", id: ctx.userId ?? null }, ...(deps.nowMs ? { nowIso: new Date(deps.nowMs).toISOString() } : {}) },
      deps.db,
    );
    if (!r.ok) return { status: r.error === "field_not_found" ? 404 : FIELD_LIST_STATUS[r.error], body: { error: r.error === "field_not_found" ? "version_not_found" : r.error } };
    return { status: 200, body: { ok: true, rev: r.list.rev, message: r.message } };
  }
  if (subject.store === "journeys") {
    if (typeof base !== "string" || !base) return { status: 400, body: { error: "invalid_input" } };
    const version = await forTenant(ctx, deps.db).lifecycleVersions.getById(versionDocId(subject.journeyId, rev));
    if (!version || version.journeyId !== subject.journeyId) return { status: 404, body: { error: "version_not_found" } };
    const r = await saveLifecycleDraft(
      ctx,
      subject.journeyId,
      { graph: version.graph, pools: version.pools, settings: version.settings },
      {
        db: deps.db,
        nowMs: deps.nowMs,
        authoredBy: "human",
        emailStyle: "keep",
        expectUpdatedAt: base,
        restoredFrom: { version: rev, by: ctx.userId ?? null },
      },
    );
    if (!r.ok) return { status: r.status, body: { error: r.error, ...(r.detail !== undefined ? { detail: r.detail } : {}) } };
    return { status: 200, body: { ok: true, issues: r.value.issues, updatedAt: r.value.journey.updatedAt } };
  }
  if (typeof base !== "number" || !Number.isInteger(base) || base < 0) return { status: 400, body: { error: "invalid_input" } };
  const r = await restoreCatalogVersion(ctx, subject.connectionId, rev, { catalogRev: base }, deps.db);
  if (r.status !== 200) return r;
  const connection = (r.body as { connection?: { catalogRev?: number } }).connection;
  return { status: 200, body: { ok: true, rev: connection?.catalogRev ?? null } };
}

/**
 * A version as a JSON file: a setting's `yougrow.settings-version`, a journey's portable document
 * (`yougrow.lifecycle-journey`, importable as a new draft), or a catalog's `yougrow.catalog-version`.
 * A journey version made before journeys changed shape can't be a draft today, so it comes as
 * `yougrow.journey-version`: its design as it was stored, to read, never imported. `draft` exports a
 * journey's draft, so it can be kept before a restore replaces it. Archived journeys (409
 * `journey_archived`) and revoked products (409 `connection_revoked`) are read only, with no export.
 */
export async function exportHistoryVersion(
  ctx: TenantContext,
  input: { subject: HistorySubject; rev: number | "draft" },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ApiResult> {
  const { subject, rev } = input;
  if (rev !== "draft" && (!Number.isInteger(rev) || rev < 0)) return { status: 400, body: { error: "invalid_input" } };
  if (subject.store === "journeys") {
    const repo = forTenant(ctx, deps.db);
    const journey = await repo.lifecycleJourneys.getById(subject.journeyId);
    if (!journey) return { status: 404, body: { error: "version_not_found" } };
    if (journey.status === "archived") return { status: 409, body: { error: "journey_archived" } };
    const r = await exportJourneyDocument(ctx, subject.journeyId, { which: rev === "draft" ? "draft" : { version: rev }, db: deps.db, nowMs: deps.nowMs });
    if (r.ok) return { status: 200, body: r.value };
    if (r.error !== "version_old_shape" || rev === "draft") return { status: r.status, body: { error: r.error } };
    const version = await repo.lifecycleVersions.getById(versionDocId(subject.journeyId, rev));
    if (!version || version.journeyId !== subject.journeyId) return { status: 404, body: { error: "version_not_found" } };
    // Only the design, as a journey document carries it: never the journey's people or its sends.
    return {
      status: 200,
      body: {
        format: JOURNEY_VERSION_FORMAT,
        formatVersion: 1,
        importable: false,
        note: "Made before journeys changed shape, so it can't be imported or put in a draft. Its design as it was stored.",
        name: journey.name,
        version: version.version,
        publishedAt: version.publishedAt,
        design: { graph: version.graph, pools: version.pools, settings: version.settings },
      },
    };
  }
  if (rev === "draft") return { status: 400, body: { error: "invalid_input" } };
  if (subject.store === "catalogs") {
    const [connection, version] = await Promise.all([forTenant(ctx, deps.db).productConnections.getById(subject.connectionId), getCatalogRevision(ctx, subject.connectionId, rev, deps.db)]);
    if (!connection || !version) return { status: 404, body: { error: "version_not_found" } };
    if (connection.status === "revoked") return { status: 409, body: { error: "connection_revoked" } };
    return { status: 200, body: { format: CATALOG_VERSION_FORMAT, formatVersion: 1, rev: version.rev, savedAt: version.savedAt, catalog: version.catalog } };
  }
  const version = await getSettingsVersion(ctx, subject.subject, rev, deps.db);
  if (!version) return { status: 404, body: { error: "version_not_found" } };
  return {
    status: 200,
    body: { format: SETTINGS_VERSION_FORMAT, formatVersion: 1, subject: version.subject, rev: version.rev, savedAt: version.savedAt, snapshot: version.snapshot },
  };
}

/** A file name for an export: `people-fields-v11.json`, `team-views-v4.json`, `journey-v3.json`, `catalog-v9.json`. */
export function exportFileName(subject: HistorySubject, rev: number | "draft"): string {
  const what =
    subject.store === "settings"
      ? subject.subject.replace(":", "-").replace("fields-person", "people-fields").replace("fields-company", "company-fields").replace("views-person", "team-views")
      : subject.store === "journeys"
        ? "journey"
        : "catalog";
  return `${what}-${rev === "draft" ? "draft" : `v${rev}`}.json`;
}
