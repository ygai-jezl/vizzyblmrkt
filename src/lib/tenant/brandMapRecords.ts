import { createHash } from "node:crypto";
import type { BrandMapStoredRecord } from "@/lib/types/brandMapRecords";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { forTenant, TENANT_FIELD, type FindOptions, type TenantCollection, type WhereClause } from "./repository";
import type { FirestoreLike, QueryLike, TenantContext } from "./types";

/**
 * The brand map's own records (BRAND_MAP_SCALE_ENABLED): groups, subjects, questions, buying
 * situations, research runs and imports, each a regional, tenant-scoped collection. What
 * TenantCollection can't do — page through a brand's records, read only some fields, and ask
 * `in` / `array-contains-any` with more than Firestore's 30 values — is done here, always
 * behind the same tenant predicate.
 *
 * A record's DOCUMENT id is a digest of its brand and its own id (`ref`). Document ids are
 * shared by every brand in a database and create() refuses one that exists anywhere, so a
 * plain id could collide with another brand's record (and would say that it exists).
 */

export type RecordKind = "grp" | "sub" | "q" | "sit" | "run" | "imp";

export const RECORD_COLLECTIONS: Record<RecordKind, string> = {
  grp: "brand_map_groups",
  sub: "brand_map_subjects",
  q: "brand_map_questions",
  sit: "brand_map_situations",
  run: "brand_map_runs",
  imp: "brand_map_imports",
};

/** Firestore's limit on the values of one `in` or `array-contains-any`. */
export const MAX_IN = 30;
const PAGE = 500;
const PARALLEL = 20;

export function recordDocId(kind: RecordKind, tenantId: string, ref: string): string {
  return `${kind}_${createHash("sha256").update(`${tenantId}\n${ref}`).digest("hex").slice(0, 40)}`;
}

/** As the app sees a record: its id is its own (`ref`), never the document's. */
const asRecord = (doc: Record<string, unknown> & { id: string }): BrandMapStoredRecord =>
  ({ ...doc, id: typeof doc.ref === "string" ? doc.ref : doc.id }) as BrandMapStoredRecord;

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function eachLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface PageAllOptions {
  where?: WhereClause[];
  /** Read only these fields (plus `ref`). */
  fields?: string[];
  pageSize?: number;
  /** A runaway backstop, not an expected limit. */
  maxPages?: number;
}

export interface BrandMapRecordStore {
  docId(kind: RecordKind, ref: string): string;
  get(kind: RecordKind, ref: string): Promise<BrandMapStoredRecord | null>;
  getMany(kind: RecordKind, refs: string[]): Promise<BrandMapStoredRecord[]>;
  find(kind: RecordKind, opts?: FindOptions): Promise<BrandMapStoredRecord[]>;
  count(kind: RecordKind, where?: WhereClause[]): Promise<number>;
  /** `field in values` (or `array-contains-any`), past Firestore's 30 values, each record once. */
  findIn(kind: RecordKind, field: string, values: unknown[], opts?: { where?: WhereClause[]; op?: "in" | "array-contains-any" }): Promise<BrandMapStoredRecord[]>;
  /** Every record of this kind (that matches `where`), a page at a time in `ref` order. */
  pageAll(kind: RecordKind, opts?: PageAllOptions): Promise<BrandMapStoredRecord[]>;
  create(kind: RecordKind, ref: string, data: Record<string, unknown>): Promise<BrandMapStoredRecord>;
  /** Create it unless this brand already has it: null when it was there. */
  createIfAbsent(kind: RecordKind, ref: string, data: Record<string, unknown>): Promise<BrandMapStoredRecord | null>;
  /** Read the freshest copy in a transaction and apply `plan`'s patch (null: leave it). */
  claim(kind: RecordKind, ref: string, plan: (current: BrandMapStoredRecord) => Record<string, unknown> | null): Promise<BrandMapStoredRecord | null>;
  remove(kind: RecordKind, ref: string): Promise<void>;
}

export function brandMapRecords(ctx: TenantContext, db?: FirestoreLike): BrandMapRecordStore {
  if (!ctx?.tenantId) throw new TenantValidationError("TenantContext.tenantId is required");
  if (!ctx.region) throw new TenantValidationError("TenantContext.region is required");
  const repos = forTenant(ctx, db);
  const collections: Record<RecordKind, TenantCollection<BrandMapStoredRecord>> = {
    grp: repos.brandMapGroups,
    sub: repos.brandMapSubjects,
    q: repos.brandMapQuestions,
    sit: repos.brandMapSituations,
    run: repos.brandMapRuns,
    imp: repos.brandMapImports,
  };
  const regionalDb = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const docId = (kind: RecordKind, ref: string) => recordDocId(kind, ctx.tenantId, ref);

  /** This brand's records of a kind, filtered by `where` (any attempt to re-filter the tenant is dropped). */
  const base = (kind: RecordKind, where: WhereClause[] = []): QueryLike => {
    let q = regionalDb.collection(RECORD_COLLECTIONS[kind]).where(TENANT_FIELD, "==", ctx.tenantId);
    for (const [field, op, value] of where) if (field !== TENANT_FIELD) q = q.where(field, op, value);
    return q;
  };

  const store: BrandMapRecordStore = {
    docId,
    async get(kind, ref) {
      const doc = await collections[kind].getById(docId(kind, ref));
      return doc ? asRecord(doc) : null;
    },
    async getMany(kind, refs) {
      const unique = [...new Set(refs.filter(Boolean))];
      const found = await eachLimited(unique, PARALLEL, (ref) => store.get(kind, ref));
      return found.filter((r): r is BrandMapStoredRecord => r !== null);
    },
    async find(kind, opts = {}) {
      return (await collections[kind].find(opts)).map(asRecord);
    },
    async count(kind, where = []) {
      return collections[kind].count(where);
    },
    async findIn(kind, field, values, opts = {}) {
      const unique = [...new Set(values)];
      const op = opts.op ?? "in";
      const pages = await eachLimited(chunks(unique, MAX_IN), 5, (chunk) =>
        collections[kind].find({ where: [...(opts.where ?? []), [field, op, chunk]] }),
      );
      const seen = new Map<string, BrandMapStoredRecord>();
      for (const doc of pages.flat()) {
        const record = asRecord(doc);
        if (!seen.has(record.id)) seen.set(record.id, record);
      }
      return [...seen.values()];
    },
    async pageAll(kind, opts = {}) {
      const size = opts.pageSize ?? PAGE;
      const maxPages = opts.maxPages ?? 1_000;
      const out: BrandMapStoredRecord[] = [];
      let after: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        let q = base(kind, opts.where).orderBy("ref", "asc");
        if (opts.fields && q.select) q = q.select(...new Set(["ref", TENANT_FIELD, ...opts.fields]));
        if (after !== null) q = q.startAfter(after);
        const snap = await q.limit(size).get();
        for (const d of snap.docs) {
          const data = d.data() ?? {};
          // Defence in depth, as getById does: a row must still be this brand's.
          if (data[TENANT_FIELD] !== ctx.tenantId) continue;
          out.push(asRecord({ id: d.id, ...data }));
        }
        if (snap.docs.length < size) break;
        const last = snap.docs[snap.docs.length - 1]!.data()?.ref;
        if (typeof last !== "string") break;
        after = last;
      }
      return out;
    },
    async create(kind, ref, data) {
      return asRecord(await collections[kind].create(docId(kind, ref), { ...data, ref } as never));
    },
    async createIfAbsent(kind, ref, data) {
      try {
        return await store.create(kind, ref, data);
      } catch (err) {
        if (err instanceof TenantIsolationError) return null;
        throw err;
      }
    },
    async claim(kind, ref, plan) {
      const done = await collections[kind].claim(docId(kind, ref), (current) => {
        const patch = plan(asRecord(current));
        if (!patch) return null;
        const { ref: _ref, ...rest } = patch;
        return rest as never;
      });
      return done ? asRecord(done) : null;
    },
    async remove(kind, ref) {
      await collections[kind].delete(docId(kind, ref));
    },
  };
  return store;
}
