import type { FirestoreLike, TransactionLike } from "../types";
import type { FakeFirestore } from "./fakeFirestore";

/**
 * TEST HELPER: the fake Firestore with firebase-admin's rule that a transaction reads before it
 * writes. The fake buffers writes and does not enforce it, so a writer could pass here and fail in
 * production. Wrapped, a get after any create, set, update or delete in the same attempt throws
 * "read after write in a transaction". Refs are passed through untouched, so the fake's conflict
 * detection still works; seed, raw and onBeforeCommit stay on the fake itself.
 */
export function readsFirst(db: FakeFirestore): FirestoreLike {
  return {
    collection: (name) => db.collection(name),
    runTransaction: (fn) =>
      db.runTransaction((txn) => {
        let wrote = false;
        const guarded: TransactionLike = {
          get: async (ref) => {
            if (wrote) throw new Error("read after write in a transaction");
            return txn.get(ref);
          },
          create: (ref, data) => {
            wrote = true;
            txn.create(ref, data);
          },
          set: (ref, data) => {
            wrote = true;
            txn.set(ref, data);
          },
          update: (ref, data) => {
            wrote = true;
            txn.update(ref, data);
          },
          delete: (ref) => {
            wrote = true;
            txn.delete(ref);
          },
        };
        return fn(guarded);
      }),
  };
}
