import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * A write-only sink for IMMUTABLE audit objects — the tamper-resistant half of
 * the audit trail. The production impl ([gcsAuditSink]) appends create-only
 * objects to a GCS bucket with a LOCKED retention policy (WORM): the runtime
 * service account holds `roles/storage.objectCreator` only, so it can append a
 * new record but can never read, overwrite, or delete one, and the locked
 * retention policy blocks deletion by ANY identity until the records age out.
 *
 * This is a structural seam (like FirestoreLike): tests inject a fake to assert
 * exactly what would be written, with no GCS round-trip.
 */
export interface AuditObjectSink {
  /**
   * Append one immutable object at `path` with `body`. MUST be create-only: a
   * write to an existing path is a no-op, never an overwrite — so a retried
   * write is idempotent and the WORM invariant holds.
   */
  put(path: string, body: string): Promise<void>;
}

function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-vizzybl",
    });
  }
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

/** True for a GCS 412 (failed `ifGenerationMatch: 0` precondition = object exists). */
export function isPreconditionFailed(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 412 || code === "412";
}

/**
 * The real WORM sink: create-only writes to `AUDIT_LOG_BUCKET`. The
 * `ifGenerationMatch: 0` precondition makes each write create-or-noop, so a
 * retried write of an already-persisted record is swallowed (412) rather than
 * attempting a forbidden overwrite.
 *
 * When `AUDIT_LOG_BUCKET` is unset (local dev / tests) this returns a NO-OP
 * sink, so non-production environments are unaffected and need no bucket.
 */
export function gcsAuditSink(): AuditObjectSink {
  const bucketName = process.env.AUDIT_LOG_BUCKET;
  if (!bucketName) {
    return { put: async () => {} };
  }
  return {
    async put(path: string, body: string): Promise<void> {
      const file = getStorage(adminApp()).bucket(bucketName).file(path);
      try {
        await file.save(body, {
          contentType: "application/json",
          resumable: false,
          // Create-only: only write if the object does not already exist.
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (err) {
        if (isPreconditionFailed(err)) return; // already persisted — idempotent
        throw err;
      }
    },
  };
}
