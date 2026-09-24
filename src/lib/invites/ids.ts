import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "@/lib/waitlist/identifiers";

/**
 * Ids and codes for invites (nav v2 phase 4). Pure (no tenant or network I/O).
 */

/** One invite per person per launch: the id is derived, so a second atomic create collides. */
export function inviteDocId(campaignId: string, signupId: string): string {
  return `inv_${createHash("sha256").update(`${campaignId}\n${signupId}`).digest("hex").slice(0, 40)}`;
}

/**
 * Tenant-salted hash of a normalised email. Invites keep this instead of the
 * address, and product users are matched by hashing their `emailNormalized`.
 */
export function inviteEmailHash(tenantId: string, email: string): string {
  return createHash("sha256").update(`${tenantId}:${normalizeEmail(email)}`).digest("hex");
}

/** The random code a product receives as `yg_invite` — 22 URL-safe characters. */
export function newInviteCode(): string {
  return randomBytes(16).toString("base64url");
}

/** What a `yg_invite` value must look like before we look it up. */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function newWaveId(): string {
  return `wav_${randomBytes(12).toString("base64url")}`;
}
