import type {
  AggregateQueryLike,
  CollectionLike,
  DocRefLike,
  DocSnapLike,
  FirestoreLike,
  OrderDir,
  QueryLike,
  QuerySnapLike,
  WhereOp,
} from "../types";

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
  ) {}

  where(field: string, op: WhereOp, value: unknown): QueryLike {
    return new FakeQuery(
      this.store,
      [...this.filters, [field, op, value]],
      this.orders,
      this.lim,
    );
  }

  orderBy(field: string, dir: OrderDir = "asc"): QueryLike {
    return new FakeQuery(
      this.store,
      this.filters,
      [...this.orders, [field, dir]],
      this.lim,
    );
  }

  limit(n: number): QueryLike {
    return new FakeQuery(this.store, this.filters, this.orders, n);
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
  doc(id?: string): DocRefLike {
    const store = this.store;
    const docId = id ?? `auto_${(autoIdSeq += 1)}`; // never reused, even after deletes
    return {
      id: docId,
      async get(): Promise<DocSnapLike> {
        const data = store.get(docId);
        return { id: docId, exists: store.has(docId), data: () => data };
      },
      async create(data: Doc) {
        if (store.has(docId)) {
          throw Object.assign(new Error(`ALREADY_EXISTS: ${docId}`), { code: 6 });
        }
        store.set(docId, stripUndefined(data));
      },
      async set(data: Doc) {
        store.set(docId, stripUndefined(data));
      },
      async update(data: Doc) {
        const cur = store.get(docId);
        if (!cur) throw new Error(`update() on missing doc ${docId}`);
        store.set(docId, stripUndefined({ ...cur, ...data }));
      },
      async delete() {
        store.delete(docId);
      },
    };
  }
}

export class FakeFirestore implements FirestoreLike {
  readonly cols = new Map<string, Map<string, Doc>>();

  collection(name: string): CollectionLike {
    return new FakeCollection(this.mapFor(name));
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
}
