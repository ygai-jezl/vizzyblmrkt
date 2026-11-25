/**
 * Sign-in switches. Each is off unless its variable is exactly "true".
 * Off, sign-in behaves as before: Google only.
 */

/** Email and password sign-in, the emailed code, forgot and change password, sign out everywhere. */
export function isPasswordSigninEnabled(): boolean {
  return process.env.PASSWORD_SIGNIN_ENABLED === "true";
}

/** The sweep deletes password accounts still unconfirmed after 7 days (off: it only logs). */
export function isPasswordCleanupDeleteEnabled(): boolean {
  return isPasswordSigninEnabled() && process.env.PASSWORD_CLEANUP_DELETE_ENABLED === "true";
}

/**
 * Whether YouGrow can create a brand for a stranger yet. False until self-serve brand creation
 * ships; while it is false, SELF_SERVE_SIGNUP_ENABLED can't let anyone in.
 */
export const SELF_SERVE_BRAND_CREATION_AVAILABLE = false;

/**
 * Anyone may create an account and set up their own brand. Needs self-serve brand creation, so
 * today this is always false whatever the switch says: turning it on early lets nobody in.
 */
export function isSelfServeSignupOpen(): boolean {
  return process.env.SELF_SERVE_SIGNUP_ENABLED === "true" && SELF_SERVE_BRAND_CREATION_AVAILABLE;
}

/** Whether an email provider is set up, so the confirmation code can reach a real inbox. */
export function isEmailProviderConfigured(): boolean {
  return Boolean(process.env.MANDRILL_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim());
}

/** Running against the Firebase Auth emulator (npm run local, the smoke test). */
export function isAuthEmulator(): boolean {
  return Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

/**
 * Password sign-in can be offered: the switch is on and a code can be delivered. On the emulator
 * the code is printed to the server log instead of emailed.
 */
export function isPasswordSigninAvailable(): boolean {
  return isPasswordSigninEnabled() && (isEmailProviderConfigured() || isAuthEmulator());
}
