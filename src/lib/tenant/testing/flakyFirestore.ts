import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database with its transactions interrupted, for testing a writer that must carry on or
 * refuse: `failOn` refuses the nth transaction (counting from 1) as Firestore refuses one under
 * contention, and `before` runs before each transaction starts, so another writer can land
 * between a read and the transaction that relies on it. Everything else is the fake's own.
 */
export function flakyFirestore(db: FakeFirestore, opts: { failOn?: number; before?: (n: number) => Promise<void> }): FakeFirestore {
  let n = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "runTransaction") {
        return async (fn: Parameters<FakeFirestore["runTransaction"]>[0]) => {
          n += 1;
          if (opts.before) await opts.before(n);
          if (n === opts.failOn) throw new Error("ABORTED: too much contention");
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
