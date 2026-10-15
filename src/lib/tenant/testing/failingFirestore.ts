import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database with some reads failing, for testing what a reader does when Firestore
 * says no (an index not READY yet, a passing error): any use of the named collections
 * throws, and with `counts`, every count rejects. Everything else is the fake's own.
 */
export function failingFirestore(db: FakeFirestore, fail: { collections?: string[]; counts?: boolean }): FakeFirestore {
  const query = (q: object): object =>
    new Proxy(q, {
      get(target, prop) {
        if (prop === "count" && fail.counts) return () => ({ get: async () => Promise.reject(new Error("count failed")) });
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          // A query built on a query fails the same way.
          return out && typeof out === "object" && "where" in out ? query(out) : out;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") {
        return (name: string) => {
          if (fail.collections?.includes(name)) throw new Error(`reading ${name} failed`);
          return query(target.collection(name));
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
