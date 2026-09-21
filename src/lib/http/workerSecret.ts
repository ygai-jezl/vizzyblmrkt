import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a machine caller's `X-Worker-Secret` header against the
 * configured secret (Cloud Scheduler drain routes). Both must be non-empty, so an
 * unset secret can never authenticate an empty header — the route falls through
 * to its admin-session path instead.
 *
 * Both sides are SHA-256'd first so the comparison is length-independent:
 * timingSafeEqual throws on unequal lengths, and a length check would leak it.
 */
export function workerSecretMatches(
  provided: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
