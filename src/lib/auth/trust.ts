/**
 * Whether the door (`ensureAdminAccess` in ./session.ts) may trust a sign-in, judged from the
 * verified ID token's claims and the account as Firebase Auth holds it now. Pure: no Firebase,
 * no Next, no clock of its own, so every rule is pinned by a table test (./trust.test.ts).
 *
 * The rules (ADR-0014):
 *  - Only Google and email and password sign-ins.
 *  - Rule 2: nothing for an unconfirmed address, or for an account carrying a sign-in whose email
 *    differs from the account's (a "trojan": someone linked their own login to an address they
 *    don't own). The token's email must be the account's, and every linked sign-in must be Google
 *    or password for the account's own address.
 *  - Rule 4: on a first sign-in (no `tenant_id` claim yet, so the account holds nothing of ours)
 *    the account must be untouched (its tokens not revoked since it was created) and explained:
 *    confirmed by the emailed code (the `email_code` claim), or created by Google in this same
 *    sign-in. Anything else is removed, and the person signs in again.
 *
 * Authorization (which addresses may get in at all) is not judged here: see ./allowlist.ts.
 */

/** The sign-in methods the door accepts. */
export const TRUSTED_PROVIDERS = ["google.com", "password"] as const;
export type TrustedProvider = (typeof TRUSTED_PROVIDERS)[number];

/**
 * How close the account's token cut-off may be to its creation and still count as untouched.
 * Firebase writes both to the second, so a new account's are equal or a second apart. Kept this
 * tight because a takeover (Google replacing an unconfirmed password account) moves the cut-off to
 * the moment it happened.
 */
export const UNTOUCHED_WINDOW_MS = 1_000;
/**
 * How close Google's account creation must be to this sign-in to count as created by it. A new
 * Google account is created by the sign-in itself, in the same second. Kept tight because someone
 * can register the address again the moment the door removes a squat, and the owner's retry must
 * not count as having created that new squat.
 */
export const GOOGLE_CREATED_WINDOW_MS = 3_000;

/** The verified ID token claims the judgement reads (a firebase-admin DecodedIdToken fits). */
export interface SignInClaims {
  email?: string;
  /** When the person signed in, in seconds since the epoch. */
  auth_time?: number;
  firebase?: { sign_in_provider?: string };
  tenant_id?: unknown;
}

/** The account as the Admin SDK reads it now (a firebase-admin UserRecord fits). */
export interface AccountFacts {
  email?: string;
  emailVerified: boolean;
  providerData: ReadonlyArray<{ providerId: string; email?: string | null }>;
  metadata: { creationTime?: string | null };
  tokensValidAfterTime?: string | null;
  customClaims?: Readonly<Record<string, unknown>> | null;
}

/**
 * Why a sign-in gets nothing, while the account stays. "provider_email_changed" is a trojan on an
 * established account that looks like a renamed Google address (signed in with Google, the token's
 * email is the account's, and only a linked Google sign-in carries another address): refused all
 * the same, but logged apart so an operator can tell it from an attack.
 */
export type RefuseReason = "provider_not_allowed" | "no_email" | "trojan" | "provider_email_changed" | "email_not_verified";
/** Why a first sign-in's account is removed. */
export type RemoveReason = "trojan" | "touched" | "unexplained";

export type TrustVerdict =
  /** Authenticated: go on to the admin list and the claims bootstrap. */
  | { kind: "pass"; provider: TrustedProvider; firstSignIn: boolean }
  /** Refused, account kept: an established account, or one that may still confirm its email. */
  | { kind: "refuse"; reason: RefuseReason; provider: string }
  /** A first sign-in the door can't trust: delete the Auth account and ask for a new sign-in. */
  | { kind: "remove"; reason: RemoveReason; provider: TrustedProvider; accountAgeSeconds: number | null };

export interface SignInFacts {
  token: SignInClaims;
  account: AccountFacts;
  /** The time now, in milliseconds since the epoch. Only used to say how old a removed account was. */
  now: number;
}

/** Judge one sign-in. Rules run in this order: provider, trojan, verified email, first sign-in. */
export function judgeSignIn({ token, account, now }: SignInFacts): TrustVerdict {
  const provider = token.firebase?.sign_in_provider ?? "";
  if (!isTrustedProvider(provider)) return { kind: "refuse", reason: "provider_not_allowed", provider };

  const accountEmail = normalEmail(account.email);
  if (!accountEmail) return { kind: "refuse", reason: "no_email", provider };

  // Established: the account already has a brand from us. Never remove it here.
  const firstSignIn = !hasClaim(account.customClaims?.tenant_id) && !hasClaim(token.tenant_id);
  const created = parseTime(account.metadata.creationTime);
  const accountAgeSeconds = created === null ? null : Math.max(0, Math.round((now - created) / 1000));

  // Rule 2: a trojan gets nothing. On a first sign-in it holds nothing of ours, so remove it.
  if (isTrojan(token, account, accountEmail)) {
    if (firstSignIn) return { kind: "remove", reason: "trojan", provider, accountAgeSeconds };
    const reason = isRenamedGoogleAddress(token, account, accountEmail, provider) ? "provider_email_changed" : "trojan";
    return { kind: "refuse", reason, provider };
  }

  // Rule 2: nothing for an unconfirmed address. Not removed: a password account confirms it next.
  if (account.emailVerified !== true) return { kind: "refuse", reason: "email_not_verified", provider };

  if (!firstSignIn) return { kind: "pass", provider, firstSignIn: false };

  // Rule 4: a first sign-in must be untouched and explained.
  if (!isUntouched(account, created)) return { kind: "remove", reason: "touched", provider, accountAgeSeconds };
  if (!isExplained(token, account, provider, created)) {
    return { kind: "remove", reason: "unexplained", provider, accountAgeSeconds };
  }
  return { kind: "pass", provider, firstSignIn: true };
}

/** The part of an address after the @, lower case, for logs that must not hold the address. */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  return at < 0 ? "" : (email ?? "").slice(at + 1).trim().toLowerCase();
}

function isTrustedProvider(p: string): p is TrustedProvider {
  return (TRUSTED_PROVIDERS as readonly string[]).includes(p);
}

/**
 * The token's email isn't the account's, the token's sign-in method isn't linked to the account
 * any more (it was replaced or removed after the token was made), or a linked sign-in is another
 * kind or another address.
 */
function isTrojan(token: SignInClaims, account: AccountFacts, accountEmail: string): boolean {
  if (normalEmail(token.email) !== accountEmail) return true;
  const provider = token.firebase?.sign_in_provider ?? "";
  if (!account.providerData.some((p) => p.providerId === provider)) return true;
  return account.providerData.some((p) => !isTrustedProvider(p.providerId) || normalEmail(p.email) !== accountEmail);
}

/**
 * The trojan looks like Google renaming the address: a Google sign-in whose token carries the
 * account's own email, where every linked sign-in is Google or password with an address, and only
 * Google ones carry another address. Firebase keeps an account's email but refreshes the linked
 * Google sign-in's on every sign-in.
 */
function isRenamedGoogleAddress(token: SignInClaims, account: AccountFacts, accountEmail: string, provider: string): boolean {
  if (provider !== "google.com" || normalEmail(token.email) !== accountEmail) return false;
  return account.providerData.every((p) => {
    const email = normalEmail(p.email);
    if (!isTrustedProvider(p.providerId) || !email) return false;
    return email === accountEmail || p.providerId === "google.com";
  });
}

/** Its tokens were never revoked after creation (a password reset or change revokes them). */
function isUntouched(account: AccountFacts, created: number | null): boolean {
  if (created === null) return false;
  if (!account.tokensValidAfterTime) return true;
  const validAfter = parseTime(account.tokensValidAfterTime);
  return validAfter !== null && Math.abs(validAfter - created) <= UNTOUCHED_WINDOW_MS;
}

/** Confirmed by the emailed code, or created by Google in this same sign-in. */
function isExplained(token: SignInClaims, account: AccountFacts, provider: TrustedProvider, created: number | null): boolean {
  if (account.customClaims?.email_code === true) return true;
  if (provider !== "google.com" || created === null) return false;
  const authTime = token.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  return Math.abs(created - authTime * 1000) <= GOOGLE_CREATED_WINDOW_MS;
}

function normalEmail(e: string | null | undefined): string {
  return (e ?? "").trim().toLowerCase();
}

function hasClaim(v: unknown): boolean {
  return typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== false;
}

function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
