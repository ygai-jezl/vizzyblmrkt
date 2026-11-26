import { forTenant, getOrganisation, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { isCatalogHistoryEnabled } from "@/lib/connect/v2/flags";
import { productNameOf } from "@/lib/connect/environments";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { versionDocId } from "@/lib/lifecycle/enrol";
import { isPlansEnabled } from "@/lib/plans/flags";
import { A_TEAM_MEMBER, FORMER_TEAM_MEMBER, teamMemberNames, type UserLookup } from "@/lib/team/names";
import type { EventActor } from "@/lib/ontology/events";
import type { CatalogRevision } from "@/lib/types/catalogRevision";
import type { LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import { isSettingsSubject, type SettingsSubject, type SettingsVersion } from "@/lib/types/settingsVersion";
import { itemChangeText } from "./archive";
import { BEFORE_HISTORY_TEXT } from "./words";

/**
 * Settings › History's sources (piece O part 2, ADR-0021): three stores turned into one list of
 * HistoryEntry, newest first, for the brand in the context only.
 *
 * - The settings log (`settings_versions`): one query per subject on B's (tenantId, subject, rev
 *   DESC) index, merged in memory. Field lists and shared connections are kinds of it.
 * - Published journey versions (`lifecycle_versions`): newest first on (tenantId, publishedAt
 *   DESC); one journey's versions are read by id, `<journeyId>_v<n>`.
 * - Catalog versions (`catalog_revisions`): newest first on (tenantId, savedAt DESC); one product's
 *   on the (connectionId, rev) index.
 *
 * KINDS says when each kind shows (while its own screen is on) and whether it can be restored here;
 * a kind is read only unless it says otherwise, so a later kind joins with one entry. One cursor
 * token holds each source's place. Who did it is a name looked up now, never an address: someone
 * no longer on the team is "Former team member", an owner of the organisation off the team (with
 * plans on) is "An owner of your organisation", and an address kept on an old record is "A team
 * member". A source that can't be read (an index still building) is left out and the page says so.
 */

export const HISTORY_KINDS = ["fields", "journeys", "catalogs", "connections"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export function isHistoryKind(v: unknown): v is HistoryKind {
  return typeof v === "string" && (HISTORY_KINDS as readonly string[]).includes(v);
}

interface KindSpec {
  /** The filter's words. */
  label: string;
  /** Where its versions are kept: the settings log (with its subjects), journeys or catalogs. */
  store: "settings" | "journeys" | "catalogs";
  subjects?: readonly SettingsSubject[];
  /** Listed while its own screen is on. */
  shown: () => boolean;
  /** Restored from History. Absent: read only here. */
  restore?: () => boolean;
}

export const KINDS: Record<HistoryKind, KindSpec> = {
  fields: { label: "Fields", store: "settings", subjects: ["fields:person", "fields:company"], shown: isFieldsEnabled, restore: () => true },
  journeys: { label: "Journeys", store: "journeys", shown: isLifecycleUiEnabled, restore: () => true },
  // Catalog versions were kept before their tab showed them, so they always list; restoring one waits for CATALOG_HISTORY_ENABLED.
  catalogs: { label: "Product catalogs", store: "catalogs", shown: () => true, restore: isCatalogHistoryEnabled },
  // Given and taken back on Settings › Organisation, so read only here.
  connections: { label: "Shared connections", store: "settings", subjects: ["connections:shared"], shown: isConnectorsSharingEnabled },
};

/** The kinds shown now, in filter order. */
export function shownKinds(): HistoryKind[] {
  return HISTORY_KINDS.filter((k) => KINDS[k].shown());
}

/** Whether a kind can be restored from History now (it shows, and it isn't read only). */
export function kindRestores(kind: HistoryKind): boolean {
  return KINDS[kind].shown() && (KINDS[kind].restore?.() ?? false);
}

/** The settings subject's kind, from KINDS. */
export function kindOfSettingsSubject(subject: SettingsSubject): HistoryKind | null {
  return HISTORY_KINDS.find((k) => KINDS[k].subjects?.includes(subject)) ?? null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A subject as History names it. */
export type HistorySubject =
  | { kind: HistoryKind; store: "settings"; subject: SettingsSubject }
  | { kind: "journeys"; store: "journeys"; journeyId: string }
  | { kind: "catalogs"; store: "catalogs"; connectionId: string };

/** `fields:person`, `journey:<id>` or `catalog:<connectionId>`, or null. */
export function parseHistorySubject(raw: unknown): HistorySubject | null {
  if (typeof raw !== "string") return null;
  if (isSettingsSubject(raw)) {
    const kind = kindOfSettingsSubject(raw);
    return kind ? { kind, store: "settings", subject: raw } : null;
  }
  const [prefix, id, ...rest] = raw.split(":");
  if (rest.length || !id || !ID.test(id)) return null;
  if (prefix === "journey") return { kind: "journeys", store: "journeys", journeyId: id };
  if (prefix === "catalog") return { kind: "catalogs", store: "catalogs", connectionId: id };
  return null;
}

export const journeySubject = (journeyId: string) => `journey:${journeyId}`;
export const catalogSubject = (connectionId: string) => `catalog:${connectionId}`;

export type ReadOnlyWhy = "archived_journey" | "revoked_connection" | "shared";

/** One version in History, as the page and Vizzy read it. */
export interface HistoryEntry {
  kind: HistoryKind;
  /** A settings subject, `journey:<id>` or `catalog:<connectionId>`. */
  subject: string;
  rev: number;
  at: string;
  /** Who, in words, never an address. */
  by: string;
  /** Why, in the saver's words, or what happened. */
  message: string | null;
  /** What changed, item by item, in plain words. */
  items: string[];
  /** For a restore (or a journey published from a restored draft): the version it brought back. */
  restoredFrom: number | null;
  /** What it is about: "People fields", "Journey ‘Welcome’", "Product catalog ‘Bookings app’". */
  name: string;
  /** A journey's live version. */
  live: boolean;
  /** Why it can't be restored here, or null. */
  readOnly: ReadOnlyWhy | null;
  canRestore: boolean;
  canExport: boolean;
  /** On a journey's live version: the version a restore put in its draft, who and when. */
  draft: { version: number; by: string; at: string } | null;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Pass back as `cursor` for older entries; null at the end. */
  next: string | null;
  /** The kinds shown now, for the filter. */
  kinds: Array<{ kind: HistoryKind; label: string }>;
  /** A source couldn't be read just now (an index still building): the list leaves it out. */
  partial: boolean;
}

export const HISTORY_PAGE = 20;
const MAX_PAGE = 50;

const SETTINGS_NAME: Record<SettingsSubject, string> = {
  "fields:person": "People fields",
  "fields:company": "Company fields",
  "connections:shared": "Shared connections",
};

/** What a settings subject is called in History. */
export function settingsSubjectName(subject: SettingsSubject): string {
  return SETTINGS_NAME[subject];
}

export { BEFORE_HISTORY_TEXT } from "./words";

// --- Who --------------------------------------------------------------------------------------

/** Who did something, before it is put in words. */
export type Who = { member: string | null } | { label: string };

export function whoOfActor(by: EventActor): Who {
  switch (by.type) {
    case "member":
      return { member: by.id };
    case "agent":
      return { label: "Vizzy" };
    case "product":
      return { label: "Your product" };
    case "person":
      return { label: "A person" };
    case "system":
      return { label: "YouGrow" };
  }
}

/** A user id, an address kept on an old record (never shown), or nobody known (YouGrow's own). */
export function whoOfSaver(saver: string | null | undefined): Who {
  if (!saver) return { label: "YouGrow" };
  if (saver.includes("@")) return { label: A_TEAM_MEMBER };
  return { member: saver };
}

export interface HistoryDeps {
  db?: FirestoreLike;
  lookup?: UserLookup;
  /** false: no address, even as a name (what Vizzy reads). */
  addresses?: boolean;
}

/** The owners of the brand's organisation, read live with plans on, else none. */
async function organisationOwners(ctx: TenantContext, db?: FirestoreLike): Promise<Set<string>> {
  if (!isPlansEnabled()) return new Set();
  try {
    const brand = db ? await getTenantById(ctx.tenantId, db) : await getTenantById(ctx.tenantId);
    if (!brand?.organisationId) return new Set();
    const org = db ? await getOrganisation(brand.organisationId, db) : await getOrganisation(brand.organisationId);
    return new Set(org && org.brandIds.includes(brand.id) ? org.ownerIds : []);
  } catch {
    return new Set();
  }
}

/** Turns each Who into words, with one names lookup for the lot. */
export async function whoNamer(ctx: TenantContext, whos: Who[], deps: HistoryDeps): Promise<(w: Who) => string> {
  const ids = whos.flatMap((w) => ("member" in w && w.member ? [w.member] : []));
  const [names, owners] = ids.length
    ? await Promise.all([teamMemberNames(ctx, ids, { db: deps.db, lookup: deps.lookup, addresses: deps.addresses }), organisationOwners(ctx, deps.db)])
    : [{} as Record<string, string>, new Set<string>()];
  return (w) => {
    if ("label" in w) return w.label;
    if (!w.member) return FORMER_TEAM_MEMBER;
    if (Object.hasOwn(names, w.member)) return names[w.member]!;
    return owners.has(w.member) ? "An owner of your organisation" : FORMER_TEAM_MEMBER;
  };
}

// --- Sources ---------------------------------------------------------------------------------

/** A source's place: the last rev read, the last (time, id) read, or done. */
type Place = number | [string, string] | "done";

interface Row {
  kind: HistoryKind;
  subject: string;
  rev: number;
  at: string;
  /** Breaks ties in time, and is the place within its source. */
  id: string;
  who: Who;
  raw: SettingsVersion | LifecycleVersion | CatalogRevision;
}

interface Source {
  key: string;
  /** Up to `n` rows after `place`, newest first. */
  fetch: (place: Place | undefined, n: number) => Promise<Row[]>;
  placeOf: (row: Row) => Place;
}

function settingsSource(ctx: TenantContext, subject: SettingsSubject, db?: FirestoreLike): Source {
  const kind = kindOfSettingsSubject(subject)!;
  return {
    key: subject,
    fetch: async (place, n) => {
      const rows = await forTenant(ctx, db).settingsVersions.find({
        where: [["subject", "==", subject]],
        orderBy: [["rev", "desc"]],
        ...(typeof place === "number" ? { startAfter: [place] } : {}),
        limit: n,
      });
      return rows.map((v) => ({ kind, subject, rev: v.rev, at: v.savedAt, id: v.id, who: whoOfActor(v.by), raw: v }));
    },
    placeOf: (row) => row.rev,
  };
}

const journeyRow = (v: LifecycleVersion): Row => ({
  kind: "journeys",
  subject: journeySubject(v.journeyId),
  rev: v.version,
  at: v.publishedAt,
  id: v.id,
  who: whoOfSaver(v.publishedBy),
  raw: v,
});

function journeysSource(ctx: TenantContext, db?: FirestoreLike): Source {
  return {
    key: "journeys",
    fetch: async (place, n) => {
      const rows = await forTenant(ctx, db).lifecycleVersions.find({
        orderBy: [
          ["publishedAt", "desc"],
          ["__name__", "desc"],
        ],
        ...(Array.isArray(place) ? { startAfter: place } : {}),
        limit: n,
      });
      return rows.map(journeyRow);
    },
    placeOf: (row) => [row.at, row.id],
  };
}

/**
 * One journey's versions, by id from its newest down: the place is the last version read. The
 * cursor comes from the browser (and from Vizzy), so the place is never trusted above the journey's
 * own newest version: a made-up one can't make a request read more versions than the journey has.
 */
function oneJourneySource(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Source {
  return {
    key: journeySubject(journeyId),
    fetch: async (place, n) => {
      const repo = forTenant(ctx, db);
      const newest = (await repo.lifecycleJourneys.getById(journeyId))?.publishedVersion ?? 0;
      let from = typeof place === "number" ? Math.min(place - 1, newest) : newest;
      const out: Row[] = [];
      while (from >= 1 && out.length < n) {
        const want = Array.from({ length: Math.min(n - out.length, from) }, (_, i) => from - i);
        const found = await Promise.all(want.map((v) => repo.lifecycleVersions.getById(versionDocId(journeyId, v))));
        for (const v of found) if (v && v.journeyId === journeyId) out.push(journeyRow(v));
        from -= want.length;
      }
      return out;
    },
    placeOf: (row) => row.rev,
  };
}

const catalogRow = (r: CatalogRevision): Row => ({
  kind: "catalogs",
  subject: catalogSubject(r.connectionId),
  rev: r.rev,
  at: r.savedAt,
  id: r.id,
  who: whoOfSaver(r.savedBy),
  raw: r,
});

function catalogsSource(ctx: TenantContext, db?: FirestoreLike): Source {
  return {
    key: "catalogs",
    fetch: async (place, n) => {
      const rows = await forTenant(ctx, db).catalogRevisions.find({
        orderBy: [
          ["savedAt", "desc"],
          ["__name__", "desc"],
        ],
        ...(Array.isArray(place) ? { startAfter: place } : {}),
        limit: n,
      });
      return rows.map(catalogRow);
    },
    placeOf: (row) => [row.at, row.id],
  };
}

function oneCatalogSource(ctx: TenantContext, connectionId: string, db?: FirestoreLike): Source {
  return {
    key: catalogSubject(connectionId),
    fetch: async (place, n) => {
      const rows = await forTenant(ctx, db).catalogRevisions.find({
        where: [["connectionId", "==", connectionId]],
        orderBy: [["rev", "desc"]],
        ...(typeof place === "number" ? { startAfter: [place] } : {}),
        limit: n,
      });
      return rows.map(catalogRow);
    },
    placeOf: (row) => row.rev,
  };
}

function sourcesFor(ctx: TenantContext, opts: { kinds: HistoryKind[]; subject: HistorySubject | null }, db?: FirestoreLike): Source[] {
  const s = opts.subject;
  if (s) {
    if (s.store === "settings") return [settingsSource(ctx, s.subject, db)];
    if (s.store === "journeys") return [oneJourneySource(ctx, s.journeyId, db)];
    return [oneCatalogSource(ctx, s.connectionId, db)];
  }
  return opts.kinds.flatMap((k) => {
    const spec = KINDS[k];
    if (spec.store === "settings") return (spec.subjects ?? []).map((subject) => settingsSource(ctx, subject, db));
    return [spec.store === "journeys" ? journeysSource(ctx, db) : catalogsSource(ctx, db)];
  });
}

// --- The cursor ------------------------------------------------------------------------------

type Places = Record<string, Place>;

function encodeCursor(places: Places): string {
  return Buffer.from(JSON.stringify({ v: 1, p: places }), "utf8").toString("base64url");
}

function validPlace(p: unknown): p is Place {
  if (p === "done") return true;
  if (typeof p === "number") return Number.isInteger(p) && p >= 0;
  return Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string" && x.length <= 200);
}

/** The places a cursor holds, or null when it isn't one of ours. */
export function decodeCursor(raw: string | null | undefined): Places | null {
  if (!raw) return {};
  if (raw.length > 4000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { v?: unknown; p?: unknown };
    if (parsed.v !== 1 || !parsed.p || typeof parsed.p !== "object" || Array.isArray(parsed.p)) return null;
    const places = parsed.p as Record<string, unknown>;
    return Object.values(places).every(validPlace) ? (places as Places) : null;
  } catch {
    return null;
  }
}

// --- The list --------------------------------------------------------------------------------

const newestFirst = (a: Row, b: Row) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1);

/** Each source's next rows after its place, merged newest first: the page, the places after it, and whether any source failed. */
async function mergeSources(sources: Source[], places: Places, limit: number): Promise<{ rows: Row[]; next: Places | null; partial: boolean }> {
  let partial = false;
  const fetched = await Promise.all(
    sources.map(async (src) => {
      const place = places[src.key];
      if (place === "done") return { src, rows: [] as Row[], failed: false };
      try {
        return { src, rows: await src.fetch(place, limit + 1), failed: false };
      } catch (err) {
        console.warn(`[settings-history] ${src.key} couldn't be read: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
        return { src, rows: [] as Row[], failed: true };
      }
    }),
  );
  const all = fetched.flatMap((f) => f.rows.map((row) => ({ row, src: f.src })));
  all.sort((a, b) => newestFirst(a.row, b.row));
  const taken = all.slice(0, limit);
  const next: Places = { ...places };
  let more = false;
  for (const f of fetched) {
    if (f.failed) {
      partial = true;
      continue;
    }
    if (places[f.src.key] === "done") continue;
    const mine = taken.filter((t) => t.src === f.src);
    const last = mine[mine.length - 1];
    if (last) next[f.src.key] = f.src.placeOf(last.row);
    // Rows read but not shown are next time's; a source that gave fewer than it was asked for, all shown, is done.
    if (f.rows.length > mine.length) more = true;
    else next[f.src.key] = "done";
  }
  return { rows: taken.map((t) => t.row), next: more ? next : null, partial };
}

export type HistoryListError = "invalid_cursor" | "invalid_subject";

/**
 * A page of the brand's history, newest first: every kind shown now, or one kind, or one subject
 * (a setting, a journey or a product). Pass `next` back as `cursor`.
 */
export async function listHistory(
  ctx: TenantContext,
  opts: { kind?: HistoryKind | null; subject?: string | null; cursor?: string | null; limit?: number } = {},
  deps: HistoryDeps = {},
): Promise<{ ok: true; page: HistoryPage } | { ok: false; error: HistoryListError }> {
  const kinds = shownKinds();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? HISTORY_PAGE)), MAX_PAGE);
  const places = decodeCursor(opts.cursor);
  if (!places) return { ok: false, error: "invalid_cursor" };
  let subject: HistorySubject | null = null;
  if (opts.subject) {
    subject = parseHistorySubject(opts.subject);
    if (!subject) return { ok: false, error: "invalid_subject" };
  }
  const wanted = subject ? [subject.kind] : opts.kind ? [opts.kind] : kinds;
  const on = wanted.filter((k) => kinds.includes(k));
  const listed = { kinds: kinds.map((k) => ({ kind: k, label: KINDS[k].label })) };
  if (!on.length) return { ok: true, page: { entries: [], next: null, partial: false, ...listed } };
  const merged = await mergeSources(sourcesFor(ctx, { kinds: on, subject }, deps.db), places, limit);
  const entries = await describeRows(ctx, merged.rows, deps);
  return { ok: true, page: { entries, next: merged.next ? encodeCursor(merged.next) : null, partial: merged.partial, ...listed } };
}

/** The journeys and products the rows name, read by id once each. */
async function subjectsOf(ctx: TenantContext, rows: Row[], db?: FirestoreLike) {
  const repo = forTenant(ctx, db);
  const journeyIds = [...new Set(rows.flatMap((r) => (r.kind === "journeys" ? [(r.raw as LifecycleVersion).journeyId] : [])))];
  const connectionIds = [...new Set(rows.flatMap((r) => (r.kind === "catalogs" ? [(r.raw as CatalogRevision).connectionId] : [])))];
  const [journeys, connections] = await Promise.all([
    Promise.all(journeyIds.map((id) => repo.lifecycleJourneys.getById(id).catch(() => null))),
    Promise.all(connectionIds.map((id) => repo.productConnections.getById(id).catch(() => null))),
  ]);
  return {
    journeys: new Map(journeyIds.map((id, i) => [id, journeys[i] ?? null] as const)),
    connections: new Map(connectionIds.map((id, i) => [id, connections[i] ?? null] as const)),
  };
}

export function journeyName(journey: Pick<LifecycleJourney, "name"> | null): string {
  return journey ? `Journey ‘${journey.name}’` : "A journey that is gone";
}

export function catalogName(connection: Pick<ProductConnection, "name"> | null): string {
  return connection ? `Product catalog ‘${productNameOf(connection)}’` : "A product that is gone";
}

/** Each row as an entry, with who in words and what it is about. */
async function describeRows(ctx: TenantContext, rows: Row[], deps: HistoryDeps): Promise<HistoryEntry[]> {
  const { journeys, connections } = await subjectsOf(ctx, rows, deps.db);
  const drafts = [...journeys.values()].flatMap((j) => (j?.draftRestoredFrom ? [j.draftRestoredFrom] : []));
  const name = await whoNamer(ctx, [...rows.map((r) => r.who), ...drafts.map((d) => whoOfSaver(d.by))], deps);
  return rows.map((row): HistoryEntry => {
    const base = { kind: row.kind, subject: row.subject, rev: row.rev, at: row.at, by: name(row.who), live: false, draft: null };
    if (row.kind === "journeys") {
      const v = row.raw as LifecycleVersion;
      const journey = journeys.get(v.journeyId) ?? null;
      const readOnly: ReadOnlyWhy | null = !journey || journey.status === "archived" ? "archived_journey" : null;
      const live = !!journey && journey.publishedVersion === v.version;
      const d = live ? journey!.draftRestoredFrom : null;
      return {
        ...base,
        message: v.restoredFrom ? `Published, from version ${v.restoredFrom}.` : "Published.",
        items: [],
        restoredFrom: v.restoredFrom ?? null,
        name: journeyName(journey),
        live,
        readOnly,
        canRestore: !readOnly && kindRestores("journeys"),
        canExport: !readOnly,
        draft: d ? { version: d.version, by: name(whoOfSaver(d.by)), at: d.at } : null,
      };
    }
    if (row.kind === "catalogs") {
      const r = row.raw as CatalogRevision;
      const connection = connections.get(r.connectionId) ?? null;
      const readOnly: ReadOnlyWhy | null = !connection || connection.status === "revoked" ? "revoked_connection" : null;
      const message =
        r.source === "before_history"
          ? BEFORE_HISTORY_TEXT
          : r.source === "restore"
            ? `Restored version ${r.restoredFrom ?? "?"}`
            : r.source === "learn"
              ? "Added from Learn from repo"
              : null;
      return {
        ...base,
        by: r.source === "before_history" ? "YouGrow" : base.by,
        message,
        items: r.changes ?? [],
        restoredFrom: r.restoredFrom ?? null,
        name: catalogName(connection),
        readOnly,
        canRestore: !readOnly && kindRestores("catalogs"),
        canExport: !readOnly,
      };
    }
    const v = row.raw as SettingsVersion;
    const readOnly: ReadOnlyWhy | null = kindRestores(row.kind) ? null : "shared";
    const items = v.items.map(itemChangeText);
    if (v.moreItems > 0) items.push(`${v.moreItems} more ${v.moreItems === 1 ? "change" : "changes"}`);
    return {
      ...base,
      message: v.message,
      items,
      restoredFrom: v.restoredFrom,
      name: settingsSubjectName(v.subject),
      readOnly,
      canRestore: !readOnly,
      canExport: true,
    };
  });
}
