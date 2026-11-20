import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database, noting every brand a query asks for: each value of a `tenantId` filter
 * (`==` or `in`) is pushed onto `asked`. For proving a reader never reads another brand's rows.
 * Everything else is the fake's own.
 */
export function recordingFirestore(db: FakeFirestore, asked: string[]): FakeFirestore {
  const query = (q: object): object =>
    new Proxy(q, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (prop === "where" && args[0] === "tenantId") asked.push(...(Array.isArray(args[2]) ? args[2] : [args[2]]).map(String));
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
