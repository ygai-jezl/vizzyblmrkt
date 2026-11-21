import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database, noting the shape of every query: each `where` as "where <field> <op>", and
 * each orderBy or startAfter by name. For proving a store is read only by id or equality, so it
 * needs no composite index (the emulator never says when one is missing).
 */
export function shapeRecordingFirestore(db: FakeFirestore, ops: string[]): FakeFirestore {
  const query = (q: object): object =>
    new Proxy(q, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (prop === "where") ops.push(`where ${String(args[0])} ${String(args[1])}`);
          if (prop === "orderBy" || prop === "startAfter") ops.push(String(prop));
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out && typeof out === "object" && "where" in out ? query(out) : out;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") return (name: string) => query(target.collection(name));
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
