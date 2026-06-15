import { createHash, randomBytes } from "node:crypto";

/**
 * Normalize an email for storage + idempotency: trim + lowercase. We do NOT
 * strip Gmail dots/plus — that would merge addresses the user considers
 * distinct. Just enough to make "Foo@Bar.com " and "foo@bar.com" the same key.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deterministic signup document id from (campaign, contact). Same campaign +
 * same email/phone => same id => Firestore's atomic create() rejects the
 * duplicate, giving us idempotent "already joined" handling for free.
 */
export function deterministicSignupId(campaignId: string, contact: string): string {
  const hash = createHash("sha256")
    .update(`${campaignId}\n${contact.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 40);
  return `sig_${hash}`;
}

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity

/**
 * Public referral token — short, unambiguous, URL-safe. Random (not derived
 * from PII, so it can't be reversed to an email).
 */
export function generateReferralToken(length = 9): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  }
  return out;
}

/**
 * High-entropy, URL-safe verification token for double opt-in. Longer than a
 * referral token because clicking it confirms an account — must be unguessable.
 */
export function generateVerificationToken(): string {
  return randomBytes(24).toString("base64url");
}
