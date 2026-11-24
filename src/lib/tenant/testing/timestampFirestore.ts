import { Timestamp } from "firebase-admin/firestore";
import type { TransactionLike } from "../types";
import type { FakeFirestore } from "./fakeFirestore";

/**
 * The fake database keeping dates the way Firestore does. A Date written to one of the named
 * collections (every collection when none are named), at any depth, is stored as a Firestore
 * Timestamp, so a read hands back an object with toDate(), seconds and nanoseconds, never a Date.
 * An invalid Date is refused when it is written, as the Admin SDK refuses it ("Value for argument
 * "seconds" is not a valid integer"), and in a transaction when the write is staged, so nothing of
 * that transaction lands. Seeded documents are stored the same way.
 *
 * The plain fake keeps the Date it was given, so a reader that treats a stored date as a Date
 * passes there and fails on Firestore. Tests of code that reads such a document back use this.
 */
export function timestampFirestore(db: FakeFirestore, collections?: readonly string[]): FakeFirestore {
  const wraps = (name: string) => !collections || collections.includes(name);
  const ours = new WeakSet<object>();

  const wrapRef = (ref: object): object => {
    const wrapped = new Proxy(ref, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if ((prop === "create" || prop === "set" || prop === "update") && typeof value === "function") {
          return (data: Record<string, unknown>) => (value as (d: unknown) => Promise<unknown>).call(target, asStored(data));
        }
        return value;
      },
    });
    ours.add(wrapped);
    return wrapped;
  };

  const wrapCollection = (col: object): object =>
    new Proxy(col, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === "doc" && typeof value === "function") return (id?: string) => wrapRef((value as (i?: string) => object).call(target, id));
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

  // A transaction's writes are converted when staged, so an invalid Date fails before any lands.
  const wrapTxn = (txn: TransactionLike): TransactionLike => ({
    get: (ref) => txn.get(ref),
    create: (ref, data) => txn.create(ref, ours.has(ref) ? asStored(data) : data),
    set: (ref, data) => txn.set(ref, ours.has(ref) ? asStored(data) : data),
    update: (ref, data) => txn.update(ref, ours.has(ref) ? asStored(data) : data),
    delete: (ref) => txn.delete(ref),
  });

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") return (name: string) => (wraps(name) ? wrapCollection(target.collection(name)) : target.collection(name));
      if (prop === "seed") return (name: string, id: string, data: Record<string, unknown>) => target.seed(name, id, wraps(name) ? asStored(data) : data);
      if (prop === "runTransaction") return <R>(fn: (txn: TransactionLike) => Promise<R>) => target.runTransaction((txn) => fn(wrapTxn(txn)));
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A value as Firestore keeps it: every Date, in plain objects and arrays too, a Timestamp. */
function asStored<T>(value: T): T {
  if (value instanceof Date) return Timestamp.fromDate(value) as T;
  if (Array.isArray(value)) return value.map(asStored) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asStored(v)])) as T;
  }
  return value;
}

/** Whether a stored value is a Timestamp as the Admin SDK hands one back (not a Date). */
export function isStoredTimestamp(value: unknown): value is { toDate(): Date; seconds: number; nanoseconds: number } {
  return (
    !(value instanceof Date) &&
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === "function" &&
    typeof (value as { seconds?: unknown }).seconds === "number" &&
    typeof (value as { nanoseconds?: unknown }).nanoseconds === "number"
  );
}
