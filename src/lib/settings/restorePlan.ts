import { forTenant, type TenantContext } from "@/lib/tenant";
import { planFieldListRestore, readFieldList } from "@/lib/audience/fieldList";
import { describeChanges } from "@/lib/connect/catalogChanges";
import { getCatalogRevision } from "@/lib/connect/catalogHistory";
import { isCatalogHistoryEnabled } from "@/lib/connect/v2/flags";
import { versionDocId } from "@/lib/lifecycle/enrol";
import type { GraphIssue } from "@/lib/lifecycle/graph";
import { validateForAudience } from "@/lib/lifecycle/service";
import { LifecycleDraftSchema, type LifecycleDraft } from "@/lib/types/lifecycle";
import { ConnectionCatalogSchema } from "@/lib/types/productConnection";
import { fieldListProblems, FIELD_LIST_SUBJECT, hasOptions, type RecordField, type RecordFieldObject } from "@/lib/types/recordField";
import { readTeamViews, TEAM_VIEWS_SUBJECT } from "@/lib/views/savedViews";
import { planTeamViewRestore, restoredViews } from "@/lib/views/versionRestore";
import { sameView } from "@/lib/views/types";
import type { SavedView } from "@/lib/types/savedView";
import { getSettingsVersion } from "./history";
import { erasedSinceArchive } from "./eraseDates";
import { isSettingsEraseEnabled } from "./flags";
import { NEVER_UNDONE, TEAM_VIEWS_FULL_TEXT } from "./words";
import { catalogName, journeyName, kindRestores, settingsSubjectName, whoNamer, whoOfActor, whoOfSaver, type HistoryDeps, type HistoryKind, type HistorySubject, type Who } from "./sources";

/**
 * What a restore does, before it is made (Settings › History, ADR-0023): for each kind, what comes
 * back, what is archived, what changes back and what a restore never undoes. Field lists show
 * exactly what restoreFieldListVersion will save (planFieldListRestore); a journey's restore fills
 * its draft only, so the live version, its people and its email style stay; a catalog's is read
 * through describeChanges, and from then on stages are read with it. Team views go back one view at
 * a time (planTeamViewRestore): the views the version names, every other one as it is now. Read only.
 */

export { NEVER_UNDONE } from "./words";

export interface PreviewRow {
  /** "Comes back", "Archived", "Changes back", "Stays empty", "Stays archived", "The draft", "Stays as it is", "Never undone". */
  label: string;
  lines: string[];
  /** A quieter line under them. */
  note?: string;
}

export interface RestorePreview {
  kind: HistoryKind;
  subject: string;
  rev: number;
  /** The question the dialog asks. */
  title: string;
  /** Who saved or published the version, in words, and when. */
  savedBy: string;
  savedAt: string;
  /** Field lists, team views and catalogs: the rev it is saved as, on top of `currentRev`. Journeys: null (only the draft changes). */
  becomes: number | null;
  currentRev: number | null;
  rows: PreviewRow[];
  /** A journey's draft has edits that aren't published, saved at this time: a restore replaces them. */
  unpublishedSince: string | null;
  /** A journey's issues against today's catalog or launch, to fix in the draft before publishing. */
  issues: GraphIssue[];
  /** A closing line, such as how a journey's restore goes live. */
  footnote: string | null;
  /** Why it can't be restored here, in words, or null. */
  refused: string | null;
  /** What a restore sends back unchanged, so one made after someone else's save answers 409. */
  base: number | string | null;
}

export type PreviewResult = { ok: true; preview: RestorePreview } | { ok: false; status: number; error: string };

const quote = (s: string) => `‘${s}’`;

/** "3 Nov", in UTC. */
export function shortDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : iso;
}

function listWords(labels: string[]): string {
  const q = labels.map(quote);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** How one field in use in both goes back: its name, its options, or both. */
function changedLine(now: RecordField, next: RecordField): string {
  const parts: string[] = [];
  if (now.label !== next.label) parts.push(`${quote(now.label)} renamed back to ${quote(next.label)}`);
  if (hasOptions(next.type) && JSON.stringify(now.options ?? []) !== JSON.stringify(next.options ?? [])) {
    const live = (next.options ?? []).filter((o) => !o.archivedAt).map((o) => o.label);
    const wasLive = new Set((now.options ?? []).filter((o) => !o.archivedAt).map((o) => o.id));
    const archived = (next.options ?? []).filter((o) => o.archivedAt && wasLive.has(o.id)).map((o) => o.label);
    let line = `${quote(next.label)} options: ${live.join(", ") || "none"}.`;
    if (archived.length) line += ` ${listWords(archived)} ${archived.length === 1 ? "is" : "are"} archived.`;
    parts.push(line);
  }
  return parts.join(". ") || `${quote(next.label)} goes back to how it was`;
}

export interface PreviewDeps extends HistoryDeps {
  nowIso?: string;
}

/** One saver in words. */
async function nameOf(ctx: TenantContext, who: Who, deps: PreviewDeps): Promise<string> {
  return (await whoNamer(ctx, [who], deps))(who);
}

/** A field list's restore: planFieldListRestore's lists in words. */
async function fieldsPreview(ctx: TenantContext, object: RecordFieldObject, rev: number, deps: PreviewDeps): Promise<PreviewResult> {
  const subject = FIELD_LIST_SUBJECT[object];
  const [current, target] = await Promise.all([readFieldList(ctx, object, deps.db), getSettingsVersion(ctx, subject, rev, deps.db)]);
  if (!target) return { ok: false, status: 404, error: "version_not_found" };
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const { items, plan } = planFieldListRestore(current.items, target.snapshot.items as unknown as RecordField[], nowIso, ctx.userId ?? null);
  const now = new Map(current.items.map((f) => [f.key, f]));
  const rows: PreviewRow[] = [];
  const after = new Map(items.map((f) => [f.key, f]));
  // Read from what the restore saves, not planRestore's first pass: an erase survives a restore.
  // A field whose values are being erased stays archived until the erase ends.
  const erasing = plan.back.filter((f) => after.get(f.key)?.archivedAt);
  const returning = plan.back.filter((f) => !after.get(f.key)?.archivedAt);
  // A field whose values were erased since it was last archived comes back empty. One erased
  // before, brought back and filled in again, then archived again, comes back with those values.
  const erasedNow = (f: RecordField) => {
    const was = now.get(f.key);
    return !!was && erasedSinceArchive(was);
  };
  const back = returning.filter((f) => !erasedNow(f));
  const empty = returning.filter(erasedNow);
  if (back.length) rows.push({ label: "Comes back", lines: back.map((f) => `${quote(f.label)}, with the values people already have`) });
  if (plan.archived.length) {
    rows.push({
      label: "Archived",
      lines: plan.archived.map((f) => `${quote(f.label)}: hidden and read only, its values kept`),
      ...(isSettingsEraseEnabled() ? { note: `${plan.archived.length === 1 ? "Its" : "Their"} 30 days before anyone can erase ${plan.archived.length === 1 ? "its" : "their"} values start today.` } : {}),
    });
  }
  const changed = plan.changed.filter((f) => !f.archivedAt && now.get(f.key) && !now.get(f.key)!.archivedAt);
  if (changed.length) rows.push({ label: "Changes back", lines: changed.map((f) => changedLine(now.get(f.key)!, items.find((x) => x.key === f.key) ?? f)) });
  if (empty.length) rows.push({ label: "Stays empty", lines: empty.map((f) => `${quote(f.label)}: its values were erased on ${shortDay(now.get(f.key)!.erasedAt!)}`) });
  if (erasing.length) rows.push({ label: "Stays archived", lines: erasing.map((f) => `${quote(f.label)}: its values are being erased`) });
  if (!rows.length) rows.push({ label: "Changes back", lines: ["Nothing: the fields are as this version had them"] });
  rows.push({ label: "Never undone", lines: [NEVER_UNDONE] });
  const full = fieldListProblems(items, object).length > 0;
  return {
    ok: true,
    preview: {
      kind: "fields",
      subject,
      rev,
      title: `Restore ${settingsSubjectName(subject)} to version ${rev}?`,
      savedBy: await nameOf(ctx, whoOfActor(target.by), deps),
      savedAt: target.savedAt,
      becomes: current.rev + 1,
      currentRev: current.rev,
      rows,
      unpublishedSince: null,
      issues: [],
      footnote: null,
      refused: full ? "Restoring it would make the list longer than it can be. Archive fields you no longer use first." : null,
      base: current.rev,
    },
  };
}

/** How one view goes back: its name, its filters, columns and sort, or both. */
function viewChangedLine(now: SavedView, next: SavedView, rev: number): string {
  const parts: string[] = [];
  if (now.label !== next.label) parts.push(`${quote(now.label)} renamed back to ${quote(next.label)}`);
  if (!sameView(now.definition, next.definition)) parts.push(`${quote(next.label)}: its filters, columns and sort as version ${rev} had them`);
  const line = parts.join(". ") || `${quote(next.label)} goes back to how it was`;
  return next.archivedAt ? `${line}. It stays archived.` : line;
}

/** Team views' restore, one view at a time: planTeamViewRestore's lists in words. */
async function viewsPreview(ctx: TenantContext, rev: number, deps: PreviewDeps): Promise<PreviewResult> {
  const [current, target] = await Promise.all([readTeamViews(ctx, deps.db), getSettingsVersion(ctx, TEAM_VIEWS_SUBJECT, rev, deps.db)]);
  if (!target) return { ok: false, status: 404, error: "version_not_found" };
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const p = planTeamViewRestore(current.items, target, { by: ctx.userId ?? null, nowIso });
  const named = [...new Set(target.items.map((i) => i.label))];
  const base: RestorePreview = {
    kind: "views",
    subject: TEAM_VIEWS_SUBJECT,
    rev,
    title: named.length === 1 ? `Restore team view ${quote(named[0]!)} to version ${rev}?` : `Restore ${named.length} team views to version ${rev}?`,
    savedBy: await nameOf(ctx, whoOfActor(target.by), deps),
    savedAt: target.savedAt,
    becomes: current.rev + 1,
    currentRev: current.rev,
    rows: [],
    unpublishedSince: null,
    issues: [],
    footnote: null,
    refused: null,
    base: current.rev,
  };
  const never: PreviewRow = { label: "Never undone", lines: [NEVER_UNDONE] };
  if (!p.ok) {
    const refused =
      p.error === "view_old_shape"
        ? `Version ${rev} of ${quote(p.label)} doesn't fit today's views, so it can't be restored. Export it to read it.`
        : `Version ${rev} changed no team view, so there is nothing to restore.`;
    return { ok: true, preview: { ...base, rows: [never], refused, base: null } };
  }
  const { plan } = p;
  const rows: PreviewRow[] = [];
  if (plan.back.length) rows.push({ label: "Comes back", lines: plan.back.map((v) => `${quote(v.label)}, in the Views menu for everyone on the team`) });
  if (plan.archived.length) rows.push({ label: "Archived", lines: plan.archived.map((v) => `${quote(v.label)}: out of the Views menu, kept to bring back`) });
  if (plan.changed.length) rows.push({ label: "Changes back", lines: plan.changed.map((c) => viewChangedLine(c.now, c.next, rev)) });
  const changes = restoredViews(plan).length > 0;
  const one = plan.same.length === 1;
  if (!changes) rows.push({ label: "Changes back", lines: [`Nothing: ${one ? `${quote(plan.same[0]!.label)} is` : "they are"} as this version had ${one ? "it" : "them"}`] });
  rows.push({ label: "Stays as it is", lines: ["Every other team view", "Everyone's Only me views"] });
  rows.push(never);
  const refused = !changes
    ? `${one ? `${quote(plan.same[0]!.label)} is` : "These views are"} already as version ${rev} had ${one ? "it" : "them"}, so there is nothing to restore.`
    : plan.problems.length
      ? TEAM_VIEWS_FULL_TEXT
      : null;
  return { ok: true, preview: { ...base, rows, refused, base: refused ? null : current.rev } };
}

/** The draft's design without its own style, which a restore keeps: what "edits that aren't published" compares. */
function designOf(d: Pick<LifecycleDraft, "graph" | "pools" | "settings">): string {
  const { emailStyle: _style, ...settings } = d.settings as LifecycleDraft["settings"] & { emailStyle?: unknown };
  return JSON.stringify({ graph: d.graph, pools: d.pools, settings });
}

async function journeyPreview(ctx: TenantContext, journeyId: string, rev: number, deps: PreviewDeps): Promise<PreviewResult> {
  const repo = forTenant(ctx, deps.db);
  const [journey, version] = await Promise.all([repo.lifecycleJourneys.getById(journeyId), repo.lifecycleVersions.getById(versionDocId(journeyId, rev))]);
  if (!journey || !version || version.journeyId !== journeyId) return { ok: false, status: 404, error: "version_not_found" };
  const name = journey.name;
  const savedBy = await nameOf(ctx, whoOfSaver(version.publishedBy), deps);
  const base: RestorePreview = {
    kind: "journeys",
    subject: `journey:${journeyId}`,
    rev,
    title: `Put version ${rev} of ${quote(name)} in the draft?`,
    savedBy,
    savedAt: version.publishedAt,
    becomes: null,
    currentRev: journey.publishedVersion,
    rows: [],
    unpublishedSince: null,
    issues: [],
    footnote: `Nothing goes live until someone presses Publish. The new version then says it came from version ${rev}.`,
    refused: null,
    base: journey.updatedAt,
  };
  if (journey.status === "archived") return { ok: true, preview: { ...base, rows: [{ label: "Never undone", lines: [NEVER_UNDONE] }], footnote: null, refused: `${journeyName(journey)} is archived, so its versions are read only.`, base: null } };
  const draft = LifecycleDraftSchema.safeParse({ graph: version.graph, pools: version.pools, settings: version.settings });
  if (!draft.success) {
    return { ok: true, preview: { ...base, rows: [{ label: "Never undone", lines: [NEVER_UNDONE] }], footnote: null, refused: `Version ${rev} was made before journeys changed shape, so it can't be put in the draft. Export it to read it.`, base: null } };
  }
  const checked = await validateForAudience(ctx, journey, draft.data, deps.db);
  if (checked.error) {
    const gone = checked.error === "launch_not_found" ? "Its launch is gone" : "Its product connection is gone";
    return { ok: true, preview: { ...base, rows: [{ label: "Never undone", lines: [NEVER_UNDONE] }], footnote: null, refused: `${gone}, so version ${rev} can't be put in the draft.`, base: null } };
  }
  const live = journey.publishedVersion ? await repo.lifecycleVersions.getById(versionDocId(journeyId, journey.publishedVersion)) : null;
  const enrolments = journey.audience?.kind === "waitlist" ? repo.waitlistEnrolments : repo.lifecycleEnrolments;
  const people = await enrolments.count([["journeyId", "==", journeyId], ["status", "==", "active"]]).catch(() => null);
  const stays: string[] = [];
  if (journey.publishedVersion) {
    const who = people === null ? "the people in this journey now" : `the ${people.toLocaleString("en-GB")} ${people === 1 ? "person" : "people"} in this journey now`;
    stays.push(`The live version ${journey.publishedVersion} and ${who}`);
  }
  stays.push("The journey's email style");
  const unpublished = !live || designOf(journey.draft) !== designOf(live);
  return {
    ok: true,
    preview: {
      ...base,
      rows: [
        { label: "The draft", lines: [`Becomes version ${rev}: its steps, emails, waits and settings.`] },
        { label: "Stays as it is", lines: stays },
        { label: "Never undone", lines: [NEVER_UNDONE] },
      ],
      unpublishedSince: unpublished ? journey.updatedAt : null,
      issues: checked.issues,
      refused: kindRestores("journeys") ? null : "Journeys aren't switched on in this copy of YouGrow.",
    },
  };
}

async function catalogPreview(ctx: TenantContext, connectionId: string, rev: number, deps: PreviewDeps): Promise<PreviewResult> {
  const [connection, version] = await Promise.all([forTenant(ctx, deps.db).productConnections.getById(connectionId), getCatalogRevision(ctx, connectionId, rev, deps.db)]);
  if (!connection || !version) return { ok: false, status: 404, error: "version_not_found" };
  const current = connection.catalogRev ?? 0;
  const savedBy = version.source === "before_history" ? "YouGrow" : await nameOf(ctx, whoOfSaver(version.savedBy), deps);
  const parsed = ConnectionCatalogSchema.safeParse(version.catalog);
  const changes = parsed.success ? describeChanges(connection.catalog, parsed.data) : [];
  const refused =
    connection.status === "revoked"
      ? "This product's connection is revoked, so its catalog is read only."
      : !parsed.success
        ? `Version ${rev} doesn't fit today's catalog, so it can't be restored. Export it to read it.`
        : !isCatalogHistoryEnabled()
          ? "Restoring a catalog isn't switched on in this copy of YouGrow."
          : null;
  return {
    ok: true,
    preview: {
      kind: "catalogs",
      subject: `catalog:${connectionId}`,
      rev,
      title: `Restore ${catalogName(connection)} to version ${rev}?`,
      savedBy,
      savedAt: version.savedAt,
      becomes: current + 1,
      currentRev: current,
      rows: [
        { label: "Changes back", lines: changes.length ? changes : ["Nothing: this is the catalog as it is now"] },
        { label: "From now on", lines: ["Stages in this product are read with this catalog."] },
        { label: "Never undone", lines: [NEVER_UNDONE] },
      ],
      unpublishedSince: null,
      issues: [],
      footnote: null,
      refused,
      base: refused ? null : current,
    },
  };
}

/** The preview of restoring `rev` of a subject, for the brand in the context. */
export async function previewRestore(ctx: TenantContext, subject: HistorySubject, rev: number, deps: PreviewDeps = {}): Promise<PreviewResult> {
  if (!Number.isInteger(rev) || rev < 0) return { ok: false, status: 400, error: "invalid_input" };
  if (subject.store === "journeys") return journeyPreview(ctx, subject.journeyId, rev, deps);
  if (subject.store === "catalogs") return catalogPreview(ctx, subject.connectionId, rev, deps);
  if (subject.subject === TEAM_VIEWS_SUBJECT) return kindRestores(subject.kind) ? viewsPreview(ctx, rev, deps) : { ok: false, status: 409, error: "read_only" };
  if (!kindRestores(subject.kind) || (subject.subject !== "fields:person" && subject.subject !== "fields:company")) {
    return { ok: false, status: 409, error: "read_only" };
  }
  return fieldsPreview(ctx, subject.subject === "fields:person" ? "person" : "company", rev, deps);
}
