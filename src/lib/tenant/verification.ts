import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext } from "./types";

/**
 * Atomically verify a signup by its double-opt-in token. Runs in a transaction
 * so two concurrent clicks can't both flip (and thus can't both trigger a
 * referral credit). The token is intentionally NOT cleared, so a re-presented
 * link (double-click, or a mail scanner that pre-fetches GET links) resolves to
 * `already_verified` instead of a confusing "invalid link". Once status is
 * verified_active the token confers nothing, and the status gate still bounds
 * the referral credit to exactly once. Scoped to tenant + campaign + regional DB.
 */
export interface VerifyResult {
  status: "verified" | "already_verified" | "not_found";
  /** Present when status === "verified" — used to credit the referrer once. */
  referralToken?: string;
  referredBySignupToken?: string | null;
}

export async function verifySignupByToken(
  ctx: TenantContext,
  campaignId: string,
  token: string,
): Promise<VerifyResult> {
  if (!token) return { status: "not_found" };
  const db = getDb(databaseIdForRegion(ctx.region));
  const query = db
    .collection("signups")
    .where("tenantId", "==", ctx.tenantId)
    .where("campaignId", "==", campaignId)
    .where("verificationToken", "==", token)
    .limit(1);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    if (snap.empty) return { status: "not_found" as const };
    const doc = snap.docs[0]!;
    const data = doc.data();
    if (data.status === "verified_active") {
      return { status: "already_verified" as const };
    }
    tx.update(doc.ref, { verified: true, status: "verified_active" });
    return {
      status: "verified" as const,
      referralToken: data.referralToken as string,
      referredBySignupToken: (data.referredBySignupToken ?? null) as string | null,
    };
  });
}
