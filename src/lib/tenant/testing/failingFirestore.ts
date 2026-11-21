import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database with some reads failing, for testing what a reader does when Firestore
 * says no (an index not READY yet, a passing error): any use of the named collections
 * throws; with `counts`, every count rejects; and with `ordered`, a query on one of those
 * collections that sets an order is refused when it runs, as Firestore refuses a query whose
 * composite index is still building. Everything else is the fake's own.
 */
export function failingFirestore(
  db: FakeFirestore,
  fail: { collections?: string[]; counts?: boolean; ordered?: string[] },
): FakeFirestore {
  const refused: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "get") return async () => Promise.reject(new Error("FAILED_PRECONDITION: The query requires an index."));
        if (prop === "count") return () => ({ get: async () => Promise.reject(new Error("FAILED_PRECONDITION: The query requires an index.")) });
        if (prop === "then") return undefined;
        return () => refused;
      },
    },
  );
  const query = (q: object, name: string): object =>
    new Proxy(q, {
      get(target, prop) {
        if (prop === "count" && fail.counts) return () => ({ get: async () => Promise.reject(new Error("count failed")) });
        if (prop === "orderBy" && fail.ordered?.includes(name)) return () => refused;
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          // A query built on a query fails the same way.
          return out && typeof out === "object" && "where" in out ? query(out, name) : out;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") {
        return (name: string) => {
          if (fail.collections?.includes(name)) throw new Error(`reading ${name} failed`);
          return query(target.collection(name), name);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
