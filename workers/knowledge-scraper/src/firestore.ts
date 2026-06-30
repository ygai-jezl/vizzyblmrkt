import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Firestore admin handle for the worker. ADC only (the Cloud Run Job runtime SA,
 * which needs roles/datastore.user). Selects the tenant's REGIONAL named database
 * exactly like the main app's src/lib/tenant/firestore.ts.
 */
const clients = new Map<string, Firestore>();

function app() {
  return getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

export function getDb(databaseId: string): Firestore {
  const cached = clients.get(databaseId);
  if (cached) return cached;
  const db = databaseId === "(default)" ? getFirestore(app()) : getFirestore(app(), databaseId);
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    /* already initialized */
  }
  clients.set(databaseId, db);
  return db;
}

export { FieldValue };
