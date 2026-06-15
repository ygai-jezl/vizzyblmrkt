import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Dev-only: create a demo admin user (idempotent) with the tenant_id / region /
 * role custom claims the session layer expects. Intended for the Auth emulator —
 * the seed route only calls this when FIREBASE_AUTH_EMULATOR_HOST is set, so it
 * never provisions a real Identity Platform user by accident.
 */
export const DEMO_ADMIN_EMAIL = "admin@vizzybl.test";
export const DEMO_ADMIN_PASSWORD = "vizzybl-demo-pass";

function app() {
  return (
    getApps()[0] ??
    initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-vizzybl" })
  );
}

export async function seedAdminUser(): Promise<{ uid: string; email: string }> {
  const auth = getAuth(app());
  let uid: string;
  try {
    uid = (
      await auth.createUser({
        email: DEMO_ADMIN_EMAIL,
        password: DEMO_ADMIN_PASSWORD,
        emailVerified: true,
      })
    ).uid;
  } catch {
    uid = (await auth.getUserByEmail(DEMO_ADMIN_EMAIL)).uid;
  }
  await auth.setCustomUserClaims(uid, {
    tenant_id: "ten_vzb",
    region: "us",
    role: "admin",
  });
  return { uid, email: DEMO_ADMIN_EMAIL };
}
