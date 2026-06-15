import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { DEFAULT_DATABASE_ID } from "./region";

/**
 * The ONE place in the codebase permitted to touch Firestore directly (the
 * ESLint isolation rule exempts src/lib/tenant/**). Everything else must go
 * through the tenant-scoped repository so every access is partitioned by
 * tenantId.
 *
 * Auth is via Application Default Credentials — the runtime service account on
 * App Hosting / Cloud Run. No key files, ever. Locally, set
 * FIRESTORE_EMULATOR_HOST to route at the emulator.
 *
 * Multi-region: pass a `databaseId` to select a region's named database. One
 * app / one service account reaches all of them. NOTE (sibling-verified): you
 * MUST use getFirestore(app, databaseId) — db.settings({ databaseId }) does NOT
 * work. The `(default)` database is both the control plane (tenants registry)
 * and the US data plane today.
 */
const clients = new Map<string, Firestore>();

function getApp(): App {
  return (
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    })
  );
}

export function getDb(databaseId: string = DEFAULT_DATABASE_ID): Firestore {
  const cached = clients.get(databaseId);
  if (cached) return cached;

  const app = getApp();
  const db =
    databaseId === DEFAULT_DATABASE_ID
      ? getFirestore(app)
      : getFirestore(app, databaseId);
  try {
    // Don't persist `undefined` fields (they break aggregation/index queries).
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if the instance was already used elsewhere (e.g. HMR).
  }
  clients.set(databaseId, db);
  return db;
}
