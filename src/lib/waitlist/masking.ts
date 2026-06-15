import type { Signup } from "@/lib/types/signup";

/**
 * PII masking for the PUBLIC, unauthenticated leaderboard. Masking happens
 * server-side BEFORE serialization — raw PII never reaches the client or the
 * CDN cache. Rules per the Leaderboard PRD:
 *
 *   amount_referred  exposed as-is
 *   first_name       exposed fully
 *   last_name        first letter + "."          Sawyer        -> S.
 *   email            first letter + masked local + masked domain
 *                                                bani@x.com    -> b***@x****
 *   phone            first 3 digits, rest masked 1234567891    -> 123 *** ****
 */

export function maskLastName(lastName: string | null | undefined): string | null {
  if (!lastName) return null;
  const trimmed = lastName.trim();
  if (!trimmed) return null;
  return `${trimmed[0]!.toUpperCase()}.`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return maskToken(email); // malformed — mask wholesale
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${maskToken(local)}@${maskToken(domain)}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 3) return "*** *** ****";
  return `${digits.slice(0, 3)} *** ****`;
}

/** First character, then one asterisk per remaining character. */
function maskToken(s: string): string {
  if (s.length === 0) return "";
  if (s.length === 1) return s;
  return s[0] + "*".repeat(s.length - 1);
}

export interface PublicLeaderboardEntry {
  rank: number;
  amount_referred: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

/** Build a masked, public leaderboard entry from a signup at a given rank. */
export function toPublicLeaderboardEntry(
  signup: Pick<
    Signup,
    "firstName" | "lastName" | "email" | "phone" | "amountReferred"
  >,
  rank: number,
): PublicLeaderboardEntry {
  return {
    rank,
    amount_referred: signup.amountReferred,
    first_name: signup.firstName ?? null,
    last_name: maskLastName(signup.lastName),
    email: maskEmail(signup.email),
    phone: maskPhone(signup.phone),
  };
}
