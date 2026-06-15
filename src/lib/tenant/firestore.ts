import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * The ONE place in the codebase permitted to touch Firestore directly (the
 * ESLint isolation rule exempts src/lib/tenant/**). Everything else must go
 * through the tenant-scoped repository so every access is partitioned by
 * tenantId.
 *
 * Auth is via Application Default Credentials — the runtime service account on
 * App Hosting / Cloud Run. No key files, ever. Locally, set
 * FIRESTORE_EMULATOR_HOST to route at the emulator.
 */
let cached: Firestore | null = null;

export function getDb(): Firestore {
  if (cached) return cached;

  let app: App | undefined = getApps()[0];
  if (!app) {
    app = initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  }

  cached = getFirestore(app);
  try {
    // Don't persist `undefined` fields (they break aggregation/index queries).
    cached.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if the instance was already used elsewhere (e.g. HMR).
  }
  return cached;
}
