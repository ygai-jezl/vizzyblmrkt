import type {
  AggregateQueryLike,
  CollectionLike,
  DocRefLike,
  DocSnapLike,
  FirestoreLike,
  OrderDir,
  QueryLike,
  QuerySnapLike,
  TransactionLike,
  WhereOp,
} from "../types";

/** A fake doc ref carries a stable version key so runTransaction can detect writes. */
type VersionedDocRef = DocRefLike & { readonly _vkey: string };

/**
 * In-memory Firestore that implements exactly the structural surface the tenant
 * repository consumes. Lets the isolation invariants be proven in fast unit
 * tests with no emulator. NOT for production use.
 */

type Doc = Record<string, unknown>;
type Row = { id: string; data: Doc };

// Approximates Firestore matching. Notably: a document whose field is ABSENT
// (undefined) is excluded by every operator except a literal `== undefined`,
// matching real Firestore (which only returns docs that contain the field).
// This is an approximation only — it does NOT model cross-type ordering.
function matchOp(actual: unknown, op: WhereOp, expected: unknown): boolean {
  if (actual === undefined && op !== "==") return false;
  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return (actual as number) > (expected as number);
    case ">=":
      return (actual as number) >= (expected as number);
    case "<":
      return (actual as number) < (expected as number);
    case "<=":
      return (actual as number) <= (expected as number);
    case "array-contains":
      return Array.isArray(actual) && actual.includes(expected);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "not-in":
      return Array.isArray(expected) && !expected.includes(actual);
    case "array-contains-any":
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        expected.some((e) => actual.includes(e))
      );
    default:
      return false;
  }
}

/** Mirror firebase-admin's ignoreUndefinedProperties: drop undefined-valued keys. */
function stripUndefined(data: Doc): Doc {
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
}

class FakeQuery implements QueryLike {
  constructor(
    protected store: Map<string, Doc>,
    protected filters: Array<[string, WhereOp, unknown]> = [],
    protected orders: Array<[string, OrderDir]> = [],
    protected lim?: number,
    protected after?: unknown[],
  ) {}

  where(field: string, op: WhereOp, value: unknown): QueryLike {
    return new FakeQuery(
      this.store,
      [...this.filters, [field, op, value]],
      this.orders,
      this.lim,
      this.after,
    );
  }

  orderBy(field: string, dir: OrderDir = "asc"): QueryLike {
    return new FakeQuery(
      this.store,
      this.filters,
      [...this.orders, [field, dir]],
      this.lim,
      this.after,
    );
  }

  limit(n: number): QueryLike {
    return new FakeQuery(this.store, this.filters, this.orders, n, this.after);
  }

  startAfter(...values: unknown[]): QueryLike {
    return new FakeQuery(this.store, this.filters, this.orders, this.lim, values);
  }

  protected rows(): Row[] {
    let rows: Row[] = [...this.store.entries()].map(([id, data]) => ({
      id,
      data,
    }));
    for (const [field, op, value] of this.filters) {
      rows = rows.filter((r) => matchOp(r.data[field], op, value));
    }
    // Real Firestore excludes any document missing an ordered field.
    for (const [field] of this.orders) {
      rows = rows.filter((r) => r.data[field] !== undefined);
    }
    for (const [field, dir] of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = a.data[field] as number | string;
        const bv = b.data[field] as number | string;
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "asc" ? c : -c;
      });
    }
    // Cursor: keep only rows that sort strictly AFTER the supplied tuple
    // (aligned to orderBy), matching firebase-admin startAfter() semantics.
    if (this.after) {
      const cursor = this.after;
      rows = rows.filter((r) => {
        for (let i = 0; i < this.orders.length; i++) {
          const [field, dir] = this.orders[i]!;
          const av = r.data[field] as number | string;
          const bv = cursor[i] as number | string;
          const c = av < bv ? -1 : av > bv ? 1 : 0;
          if (c !== 0) return (dir === "asc" ? c : -c) > 0;
        }
        return false; // exactly equal to the cursor → excluded
      });
    }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    return rows;
  }

  async get(): Promise<QuerySnapLike> {
    const rows = this.rows();
    return {
      empty: rows.length === 0,
      size: rows.length,
      docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
    };
  }

  count(): AggregateQueryLike {
    return {
      get: async () => ({ data: () => ({ count: this.rows().length }) }),
    };
  }
}

let autoIdSeq = 0;

class FakeCollection extends FakeQuery implements CollectionLike {
  constructor(
    store: Map<string, Doc>,
    private readonly colName: string,
    private readonly owner: FakeFirestore,
  ) {
    super(store);
  }

  doc(id?: string): DocRefLike {
    const store = this.store;
    const owner = this.owner;
    const docId = id ?? `auto_${(autoIdSeq += 1)}`; // never reused, even after deletes
    const vkey = `${this.colName}::${docId}`;
    const bump = () => owner._bumpVersion(vkey);
    const ref: VersionedDocRef = {
      id: docId,
      _vkey: vkey,
      async get(): Promise<DocSnapLike> {
        const data = store.get(docId);
        return { id: docId, exists: store.has(docId), data: () => data };
      },
      async create(data: Doc) {
        if (store.has(docId)) {
          throw Object.assign(new Error(`ALREADY_EXISTS: ${docId}`), { code: 6 });
        }
        store.set(docId, stripUndefined(data));
        bump();
      },
      async set(data: Doc) {
        store.set(docId, stripUndefined(data));
        bump();
      },
      async update(data: Doc) {
        const cur = store.get(docId);
        if (!cur) throw new Error(`update() on missing doc ${docId}`);
        store.set(docId, stripUndefined({ ...cur, ...data }));
        bump();
      },
      async delete() {
        store.delete(docId);
        bump();
      },
    };
    return ref;
  }
}

export class FakeFirestore implements FirestoreLike {
  readonly cols = new Map<string, Map<string, Doc>>();
  /** Per-document write counter, keyed `${collection}::${id}` — powers optimistic
   *  concurrency in runTransaction (a read records the version; commit aborts if it
   *  changed). Bumped by every write, transactional or not. */
  private readonly versions = new Map<string, number>();
  /**
   * TEST HOOK: a one-shot callback fired inside the NEXT runTransaction, after its
   * reads but before commit. Use it to inject a concurrent writer and exercise the
   * abort/retry path (proves exactly-once). Cleared after it fires once.
   */
  onBeforeCommit?: () => Promise<void> | void;

  collection(name: string): CollectionLike {
    return new FakeCollection(this.mapFor(name), name, this);
  }

  /** @internal — bump a document's version (called by fake doc refs on write). */
  _bumpVersion(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  private versionOf(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /**
   * Approximates firebase-admin runTransaction: buffers writes, applies them
   * atomically on commit, and re-runs the function (up to a cap) when any document
   * it READ was written by someone else in the meantime (optimistic concurrency).
   * Single-threaded, so genuine interleaving is simulated via `onBeforeCommit`.
   */
  async runTransaction<R>(fn: (txn: TransactionLike) => Promise<R>): Promise<R> {
    const MAX_ATTEMPTS = 8;
    let lastConflict: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const reads = new Map<string, number>();
      const writes: Array<() => Promise<void>> = [];
      const txn: TransactionLike = {
        get: async (ref) => {
          const key = (ref as Partial<VersionedDocRef>)._vkey;
          if (typeof key !== "string") {
            // A re-wrapped/decorated ref that dropped _vkey would collapse every doc
            // into one version bucket → nonsense conflict detection. Fail loudly
            // instead of silently reporting a green-but-meaningless transaction test.
            throw new Error(
              "FakeFirestore.runTransaction: txn.get() needs a ref from this fake's collection().doc() (missing _vkey — a wrapper must preserve it)",
            );
          }
          reads.set(key, this.versionOf(key));
          return ref.get();
        },
        create: (ref, data) => void writes.push(() => ref.create(data).then(() => {})),
        set: (ref, data) => void writes.push(() => ref.set(data).then(() => {})),
        update: (ref, data) => void writes.push(() => ref.update(data).then(() => {})),
        delete: (ref) => void writes.push(() => ref.delete().then(() => {})),
      };
      const result = await fn(txn);
      // Simulate a concurrent writer landing between our reads and our commit.
      const hook = this.onBeforeCommit;
      if (hook) {
        this.onBeforeCommit = undefined;
        await hook();
      }
      const conflicted = [...reads].some(([key, v]) => this.versionOf(key) !== v);
      if (conflicted) {
        lastConflict = Object.assign(new Error("ABORTED: transaction contention"), { code: 10 });
        continue; // re-run the function against fresh state
      }
      for (const apply of writes) await apply();
      return result;
    }
    throw lastConflict ?? Object.assign(new Error("ABORTED: transaction contention"), { code: 10 });
  }

  private mapFor(name: string): Map<string, Doc> {
    let m = this.cols.get(name);
    if (!m) {
      m = new Map();
      this.cols.set(name, m);
    }
    return m;
  }

  /** Seed a raw document, bypassing the repository (simulates other tenants). */
  seed(collection: string, id: string, data: Doc): void {
    this.mapFor(collection).set(id, data);
  }

  /** Read a raw document, bypassing the repository (to assert what was stored). */
  raw(collection: string, id: string): Doc | undefined {
    return this.cols.get(collection)?.get(id);
  }

  /** All documents in a collection (to assert appends, e.g. audit rows). */
  dump(collection: string): Doc[] {
    return Array.from(this.cols.get(collection)?.values() ?? []);
  }

  /** How many times a document was written (create/set/update/delete). Lets a test
   *  assert a contended doc was mutated EXACTLY once, i.e. no losing writer applied. */
  writeCountFor(collection: string, id: string): number {
    return this.versions.get(`${collection}::${id}`) ?? 0;
  }
}
