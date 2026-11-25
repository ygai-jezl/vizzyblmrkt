import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { addTenantMember } from "@/lib/tenant";
import { GOOGLE_ID_CLAIM } from "@/lib/auth/trust";
import { SEED_TENANT_ID } from "./seedDemo";

/**
 * Dev-only: create a demo admin user (idempotent) with the tenant_id / region /
 * role custom claims the session layer expects. Intended for the Auth emulator:
 * callers only run this when FIREBASE_AUTH_EMULATOR_HOST is set, so it never
 * provisions a real Identity Platform user by accident.
 *
 * The user also has a linked Google identity, so the emulator's Google sign-in
 * page lists it: a local run signs in with "Sign in with Google" like the real
 * app. The password is for scripts (the smoke test) and only exists in the
 * emulator. The address must be on ADMIN_ALLOWED_EMAILS (npm run local sets it).
 *
 * It also gets a membership row in the demo brand (tenant_users), so Plan and usage counts one
 * user locally. The claims alone reach the brand, so nothing else changes.
 */
export const DEMO_ADMIN_EMAIL = "admin@example.com";
export const DEMO_ADMIN_PASSWORD = "local-demo-password";
const DEMO_ADMIN_NAME = "Demo Admin";
/** The fake Google account id the emulator links to the demo admin. */
const DEMO_ADMIN_GOOGLE_UID = "demo-admin-google";

function app() {
  return (
    getApps()[0] ??
    initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-yougrow" })
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
        displayName: DEMO_ADMIN_NAME,
      })
    ).uid;
  } catch {
    uid = (await auth.getUserByEmail(DEMO_ADMIN_EMAIL)).uid;
  }
  const user = await auth.getUser(uid);
  if (!user.providerData.some((p) => p.providerId === "google.com")) {
    await auth.updateUser(uid, {
      providerToLink: {
        providerId: "google.com",
        uid: DEMO_ADMIN_GOOGLE_UID,
        email: DEMO_ADMIN_EMAIL,
        displayName: DEMO_ADMIN_NAME,
      },
    });
  }
  await auth.setCustomUserClaims(uid, {
    tenant_id: SEED_TENANT_ID,
    region: "us",
    role: "admin",
    // The linked Google account's permanent id, as the door records it at a first sign-in.
    [GOOGLE_ID_CLAIM]: DEMO_ADMIN_GOOGLE_UID,
  });
  await addTenantMember(uid, SEED_TENANT_ID, "admin"); // idempotent
  return { uid, email: DEMO_ADMIN_EMAIL };
}
