import { describe, expect, it } from "vitest";
import {
  emailDomain,
  GOOGLE_CREATED_WINDOW_MS,
  GOOGLE_ID_CLAIM,
  googleIdAtBootstrap,
  googleIdToBackfill,
  judgeSignIn,
  UNTOUCHED_WINDOW_MS,
  type AccountFacts,
  type SignInClaims,
  type TrustVerdict,
} from "./trust";

// Firebase Auth writes account times as UTC strings to the second, and auth_time in seconds.
const CREATED = Date.parse("2026-11-24T10:00:00Z");
const NOW = CREATED + 60_000;
const utc = (ms: number) => new Date(ms).toUTCString();
const EMAIL = "alex@example.com";

/** `googleId` is the Google account id the token's sign-in used (`firebase.identities["google.com"][0]`). */
function token(o: Partial<SignInClaims> & { provider?: string; googleId?: string } = {}): SignInClaims {
  const { provider = "google.com", googleId, ...rest } = o;
  const identities = googleId === undefined ? {} : { identities: { "google.com": [googleId], email: [EMAIL] } };
  return { email: EMAIL, auth_time: CREATED / 1000, firebase: { sign_in_provider: provider, ...identities }, ...rest };
}

function account(o: Partial<AccountFacts> = {}): AccountFacts {
  return {
    email: EMAIL,
    emailVerified: true,
    providerData: [{ providerId: "google.com", email: EMAIL }],
    metadata: { creationTime: utc(CREATED) },
    tokensValidAfterTime: utc(CREATED),
    customClaims: null,
    ...o,
  };
}

const established = { tenant_id: "ten_demo", region: "us", role: "admin" };
const passwordOnly = [{ providerId: "password", email: EMAIL }];
// A renamed Google address: the same Google account (same id) now carries alex.smith@.
const GID = "100000000000000000001";
const OTHER_GID = "100000000000000000002";
const RENAMED = "alex.smith@example.com";
const renamedGoogle = (uid: string | null = GID) => ({ providerId: "google.com", email: RENAMED, uid });
const recorded = (id: unknown = GID) => ({ ...established, [GOOGLE_ID_CLAIM]: id });
const judge = (t: SignInClaims, a: AccountFacts, now = NOW) => judgeSignIn({ token: t, account: a, now });
type Want = Partial<Record<keyof Extract<TrustVerdict, { kind: "remove" }> | "firstSignIn" | "renamedEmail", unknown>>;
const pass = (provider: string, firstSignIn: boolean): Want => ({ kind: "pass", provider, firstSignIn });
const removed = (reason: string, provider = "google.com"): Want => ({ kind: "remove", reason, provider });
const refused = (reason: string, provider = "google.com"): Want => ({ kind: "refuse", reason, provider });
const renamed = (renamedEmail = RENAMED): Want => ({ kind: "pass", provider: "google.com", firstSignIn: false, renamedEmail });

describe("judgeSignIn", () => {
  it.each<[string, SignInClaims, AccountFacts, Want]>([
    // Rule 4, Google: an account Google created in this very sign-in.
    ["a fresh Google sign-in passes", token(), account(), pass("google.com", true)],
    ["Google created it up to 3 s before the sign-in", token({ auth_time: (CREATED + GOOGLE_CREATED_WINDOW_MS) / 1000 }), account(), pass("google.com", true)],
    ["a Google sign-in 4 s after the account was made, with no marker, is removed", token({ auth_time: (CREATED + 4_000) / 1000 }), account(), removed("unexplained")],
    ["a Google sign-in with no auth_time is removed", token({ auth_time: undefined }), account(), removed("unexplained")],
    ["a Google sign-in on a squatted, now linked account is removed", token({ auth_time: (CREATED + 3_600_000) / 1000 }), account({ providerData: [...passwordOnly, { providerId: "google.com", email: EMAIL }] }), removed("unexplained")],
    // Rule 4, password: confirmed by the emailed code.
    ["a password sign-in with the marker, untouched, passes", token({ provider: "password", auth_time: (CREATED + 3_600_000) / 1000 }), account({ providerData: passwordOnly, customClaims: { email_code: true } }), pass("password", true)],
    ["untouched also when tokensValidAfterTime is absent", token({ provider: "password" }), account({ providerData: passwordOnly, tokensValidAfterTime: undefined, customClaims: { email_code: true } }), pass("password", true)],
    ["untouched up to 1 s after creation (Firebase writes both to the second)", token({ provider: "password" }), account({ providerData: passwordOnly, tokensValidAfterTime: utc(CREATED + UNTOUCHED_WINDOW_MS), customClaims: { email_code: true } }), pass("password", true)],
    ["a password sign-in with the marker but touched (a reset since) is removed", token({ provider: "password" }), account({ providerData: passwordOnly, tokensValidAfterTime: utc(CREATED + 2_000), customClaims: { email_code: true } }), removed("touched", "password")],
    ["a verified password account without the marker is removed", token({ provider: "password" }), account({ providerData: passwordOnly }), removed("unexplained", "password")],
    ["the marker must be exactly true", token({ provider: "password" }), account({ providerData: passwordOnly, customClaims: { email_code: "true" } }), removed("unexplained", "password")],
    ["a Google sign-in Google just created but touched is removed", token(), account({ tokensValidAfterTime: utc(CREATED + 10_000) }), removed("touched")],
    ["an account with no creation time is removed on a first sign-in", token(), account({ metadata: { creationTime: null } }), removed("touched")],
    ["a Google sign-in on a code-confirmed account passes", token({ auth_time: (CREATED + 3_600_000) / 1000 }), account({ providerData: [...passwordOnly, { providerId: "google.com", email: EMAIL }], customClaims: { email_code: true } }), pass("google.com", true)],
    // Rule 2: trojans.
    ["a trojan on a first sign-in is removed", token(), account({ providerData: [...passwordOnly, { providerId: "google.com", email: "someone@example.test" }] }), removed("trojan")],
    ["a trojan on an established account is refused, not removed", token({ provider: "password" }), account({ providerData: [...passwordOnly, { providerId: "google.com", email: "someone@example.test" }], customClaims: established }), refused("trojan", "password")],
    ["a trojan is caught before the email check", token({ provider: "password" }), account({ emailVerified: false, providerData: [...passwordOnly, { providerId: "google.com", email: "someone@example.test" }] }), removed("trojan", "password")],
    ["a linked sign-in of another kind is a trojan", token(), account({ providerData: [{ providerId: "google.com", email: EMAIL }, { providerId: "phone" }] }), removed("trojan")],
    ["a linked sign-in with no email is a trojan", token(), account({ providerData: [{ providerId: "google.com", email: EMAIL }, { providerId: "password", email: null }] }), removed("trojan")],
    ["a token email that isn't the account's is a trojan", token({ email: "someone@example.test" }), account(), removed("trojan")],
    ["a password token on an account with only Google linked is a trojan, removed", token({ provider: "password" }), account(), removed("trojan", "password")],
    ["a password token on an established account with only Google linked is refused", token({ provider: "password" }), account({ customClaims: established }), refused("trojan", "password")],
    ["a Google token on an account whose Google sign-in was replaced is a trojan, removed", token(), account({ providerData: passwordOnly }), removed("trojan")],
    ["a token email that isn't the account's is refused on an established account", token({ email: "someone@example.test" }), account({ customClaims: established }), refused("trojan")],
    // A renamed Google address on an established account: still refused, logged under its own reason.
    ["an established account whose Google address was renamed is refused as provider_email_changed", token(), account({ providerData: [{ providerId: "google.com", email: "alex.smith@example.com" }], customClaims: established }), refused("provider_email_changed")],
    ["a renamed Google address next to the account's own password is provider_email_changed too", token(), account({ providerData: [...passwordOnly, { providerId: "google.com", email: "alex.smith@example.com" }], customClaims: established }), refused("provider_email_changed")],
    ["a renamed Google address on a first sign-in is a trojan, removed", token(), account({ providerData: [{ providerId: "google.com", email: "alex.smith@example.com" }] }), removed("trojan")],
    ["another address on a Google sign-in, signed in with a password, stays a trojan", token({ provider: "password" }), account({ providerData: [...passwordOnly, { providerId: "google.com", email: "alex.smith@example.com" }], customClaims: established }), refused("trojan", "password")],
    ["another address on a password sign-in is never provider_email_changed", token(), account({ providerData: [{ providerId: "google.com", email: "alex.smith@example.com" }, { providerId: "password", email: "someone@example.test" }], customClaims: established }), refused("trojan")],
    ["a token email that isn't the account's is never provider_email_changed", token({ email: "alex.smith@example.com" }), account({ providerData: [{ providerId: "google.com", email: "alex.smith@example.com" }], customClaims: established }), refused("trojan")],
    ["emails match whatever their case", token({ email: "Alex@Example.com" }), account({ providerData: [{ providerId: "google.com", email: "ALEX@example.com" }] }), pass("google.com", true)],
    // A renamed Google address with the Google account id recorded: the same id passes as a rename.
    ["a rename by the same Google account (token, linked sign-in and recorded id agree) passes with the new address", token({ googleId: GID }), account({ providerData: [renamedGoogle()], customClaims: recorded() }), renamed()],
    ["a same-id rename next to the account's own password passes too", token({ googleId: GID }), account({ providerData: [...passwordOnly, renamedGoogle()], customClaims: recorded() }), renamed()],
    ["the new address keeps the case Google gives it", token({ googleId: GID }), account({ providerData: [{ providerId: "google.com", email: "Alex.Smith@example.com", uid: GID }], customClaims: recorded() }), renamed("Alex.Smith@example.com")],
    ["the rename shape with ids but none recorded is refused as provider_email_changed", token({ googleId: GID }), account({ providerData: [renamedGoogle()], customClaims: established }), refused("provider_email_changed")],
    ["a recorded id that isn't a string counts as none recorded", token({ googleId: GID }), account({ providerData: [renamedGoogle()], customClaims: recorded(42) }), refused("provider_email_changed")],
    ["the rename shape where the linked Google account has another id is a trojan", token({ googleId: OTHER_GID }), account({ providerData: [renamedGoogle(OTHER_GID)], customClaims: recorded() }), refused("trojan")],
    ["the rename shape where the token's Google identity differs is a trojan", token({ googleId: OTHER_GID }), account({ providerData: [renamedGoogle()], customClaims: recorded() }), refused("trojan")],
    ["the rename shape with no Google identity in the token is a trojan", token(), account({ providerData: [renamedGoogle()], customClaims: recorded() }), refused("trojan")],
    ["the rename shape whose linked Google sign-in has no id is a trojan", token({ googleId: GID }), account({ providerData: [renamedGoogle(null)], customClaims: recorded() }), refused("trojan")],
    ["a Google token on an account with no Google sign-in linked, id recorded, is a trojan", token({ googleId: GID }), account({ providerData: passwordOnly, customClaims: recorded() }), refused("trojan")],
    ["a same-id rename signed in with a password is never a rename", token({ provider: "password", googleId: GID }), account({ providerData: [...passwordOnly, renamedGoogle()], customClaims: recorded() }), refused("trojan", "password")],
    ["a same-id rename next to a password for another address is a trojan", token({ googleId: GID }), account({ providerData: [renamedGoogle(), { providerId: "password", email: "someone@example.test" }], customClaims: recorded() }), refused("trojan")],
    ["a same-id rename whose token email isn't the account's is a trojan", token({ email: RENAMED, googleId: GID }), account({ providerData: [renamedGoogle()], customClaims: recorded() }), refused("trojan")],
    ["a same-id rename on an unverified account is refused as unverified", token({ googleId: GID }), account({ emailVerified: false, providerData: [renamedGoogle()], customClaims: recorded() }), refused("email_not_verified")],
    ["a same-id rename on a first sign-in is still a trojan, removed", token({ googleId: GID }), account({ providerData: [renamedGoogle()], customClaims: { [GOOGLE_ID_CLAIM]: GID } }), removed("trojan")],
    // Rule 2: verified email.
    ["an unverified password account is refused, not removed", token({ provider: "password" }), account({ emailVerified: false, providerData: passwordOnly }), refused("email_not_verified", "password")],
    ["an unverified Google account is refused", token(), account({ emailVerified: false }), refused("email_not_verified")],
    ["an established unverified account is refused", token({ provider: "password" }), account({ emailVerified: false, providerData: passwordOnly, customClaims: established }), refused("email_not_verified", "password")],
    // Established accounts skip rule 4.
    ["an established account skips rule 4", token({ provider: "password", auth_time: (CREATED + 9_000_000) / 1000 }), account({ providerData: passwordOnly, tokensValidAfterTime: utc(CREATED + 9_000_000), customClaims: established }), pass("password", false)],
    ["a token tenant_id alone also counts as established", token({ tenant_id: "ten_demo", auth_time: (CREATED + 9_000_000) / 1000 }), account(), pass("google.com", false)],
    ["the seeded local admin (password and Google, claims) passes with a password", token({ provider: "password", auth_time: (CREATED + 9_000_000) / 1000 }), account({ providerData: [...passwordOnly, { providerId: "google.com", email: EMAIL }], customClaims: established }), pass("password", false)],
    // Only Google and password.
    ["an anonymous sign-in is refused", token({ provider: "anonymous" }), account(), refused("provider_not_allowed", "anonymous")],
    ["a custom token is refused", token({ provider: "custom" }), account({ customClaims: established }), refused("provider_not_allowed", "custom")],
    ["a token with no provider is refused", { email: EMAIL }, account(), refused("provider_not_allowed", "")],
    ["an account with no email is refused", token(), account({ email: undefined }), refused("no_email")],
  ])("%s", (_name, t, a, want) => {
    expect(judge(t, a)).toMatchObject(want);
  });

  it("says how old a removed account was, from the clock it is given", () => {
    const old = token({ auth_time: (CREATED + 3_600_000) / 1000 });
    expect(judge(old, account(), CREATED + 90_000)).toMatchObject({ kind: "remove", accountAgeSeconds: 90 });
    expect(judge(old, account({ metadata: { creationTime: "not a date" } }))).toMatchObject({ kind: "remove", accountAgeSeconds: null });
  });

  it("carries a new address only on a rename", () => {
    const ordinary = judge(token({ googleId: GID }), account({ providerData: [{ providerId: "google.com", email: EMAIL, uid: GID }], customClaims: recorded() }));
    expect(ordinary).toEqual({ kind: "pass", provider: "google.com", firstSignIn: false });
    expect(judge(token(), account())).not.toHaveProperty("renamedEmail");
  });

  it("never removes an established account, whatever else is wrong", () => {
    const badAccounts: AccountFacts[] = [
      account({ customClaims: established, tokensValidAfterTime: utc(CREATED + 600_000) }),
      account({ customClaims: established, providerData: [{ providerId: "google.com", email: "someone@example.test" }] }),
      account({ customClaims: established, metadata: { creationTime: null } }),
    ];
    for (const a of badAccounts) {
      expect(judge(token({ auth_time: (CREATED + 3_600_000) / 1000 }), a).kind).not.toBe("remove");
    }
  });
});

describe("googleIdAtBootstrap", () => {
  it("is the uid of the account's one linked Google sign-in", () => {
    expect(googleIdAtBootstrap(account({ providerData: [{ providerId: "google.com", email: EMAIL, uid: GID }] }))).toBe(GID);
    expect(googleIdAtBootstrap(account({ providerData: [...passwordOnly, { providerId: "google.com", email: EMAIL, uid: GID }] }))).toBe(GID);
  });

  it("is null with no Google sign-in, more than one, or one with no id", () => {
    expect(googleIdAtBootstrap(account({ providerData: passwordOnly }))).toBeNull();
    expect(googleIdAtBootstrap(account({ providerData: [{ providerId: "google.com", email: EMAIL, uid: GID }, { providerId: "google.com", email: EMAIL, uid: OTHER_GID }] }))).toBeNull();
    expect(googleIdAtBootstrap(account({ providerData: [{ providerId: "google.com", email: EMAIL }] }))).toBeNull();
    expect(googleIdAtBootstrap(account({ providerData: [{ providerId: "google.com", email: EMAIL, uid: " " }] }))).toBeNull();
  });
});

describe("googleIdToBackfill", () => {
  const linked = [{ providerId: "google.com", email: EMAIL, uid: GID }];
  const later = token({ googleId: GID, auth_time: (CREATED + 9_000_000) / 1000 });
  const backfill = (t: SignInClaims, a: AccountFacts) => googleIdToBackfill(t, a, judge(t, a));

  it("is the linked Google id on a passing Google sign-in with none recorded", () => {
    expect(backfill(later, account({ providerData: linked, customClaims: established }))).toBe(GID);
    expect(backfill(later, account({ providerData: [...passwordOnly, ...linked], customClaims: established }))).toBe(GID);
  });

  it("is null on a password sign-in, even with Google linked", () => {
    const pw = token({ provider: "password", auth_time: (CREATED + 9_000_000) / 1000 });
    const a = account({ providerData: [...passwordOnly, ...linked], customClaims: established });
    expect(judge(pw, a).kind).toBe("pass");
    expect(backfill(pw, a)).toBeNull();
  });

  it("is null once an id is recorded", () => {
    expect(backfill(later, account({ providerData: linked, customClaims: recorded() }))).toBeNull();
    expect(backfill(later, account({ providerData: linked, customClaims: recorded(OTHER_GID) }))).toBeNull();
  });

  it("is null on a rename, a refusal or a removal", () => {
    expect(backfill(later, account({ providerData: [renamedGoogle()], customClaims: recorded() }))).toBeNull();
    expect(backfill(later, account({ providerData: [renamedGoogle()], customClaims: established }))).toBeNull();
    expect(backfill(later, account({ providerData: linked, emailVerified: false, customClaims: established }))).toBeNull();
    expect(backfill(later, account({ providerData: linked }))).toBeNull();
  });

  it("is null when the linked Google sign-in has no id", () => {
    expect(backfill(later, account({ customClaims: established }))).toBeNull();
  });

  it("reads the verdict it is given, so a pass for another address never records", () => {
    const a = account({ providerData: [renamedGoogle()], customClaims: established });
    const fakePass: TrustVerdict = { kind: "pass", provider: "google.com", firstSignIn: false };
    expect(googleIdToBackfill(later, a, fakePass)).toBeNull();
  });
});

describe("emailDomain", () => {
  it("keeps only the domain, lower case", () => {
    expect(emailDomain("Alex@Example.COM")).toBe("example.com");
    expect(emailDomain("no-at-sign")).toBe("");
    expect(emailDomain(undefined)).toBe("");
  });
});
