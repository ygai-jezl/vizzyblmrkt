import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

/**
 * Firebase Auth on the server, for looking team members up by user id (their names on history
 * screens). Reuses the app the session or the database already started, else starts it as
 * src/lib/auth/session.ts does: the emulators' demo project locally, Application Default
 * Credentials elsewhere.
 */
function app(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-yougrow" });
  }
  return initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
}

export function adminAuth(): Auth {
  return getAuth(app());
}
