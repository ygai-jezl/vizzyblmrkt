import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext } from "./types";

/**
 * Credit a referrer when a new signup arrives via their referral token.
 *
 * ATOMIC: runs in a Firestore transaction so concurrent referrals can't lose an
 * increment, and recomputes the sortable `score` from the new referral count in
 * the same write (score = amountReferred × spotsToMoveUponReferral). Rejects
 * self-referral. Runs against the tenant's REGIONAL database. Lives in the
 * tenant layer because it is the one place transactions/raw access are allowed.
 *
 * Idempotency is the caller's responsibility: credit exactly once, on the FIRST
 * creation of a signup (the signup API skips this on an idempotent re-submit).
 */
export interface CreditReferralResult {
  credited: boolean;
  reason: "ok" | "self-referral" | "referrer-not-found" | "no-token";
  referrerId?: string;
  newAmountReferred?: number;
}

export async function creditReferral(
  ctx: TenantContext,
  campaignId: string,
  referrerToken: string,
  newSignupToken: string,
  spotsToMoveUponReferral: number,
): Promise<CreditReferralResult> {
  if (!referrerToken) return { credited: false, reason: "no-token" };
  if (referrerToken === newSignupToken) {
    return { credited: false, reason: "self-referral" };
  }

  const db = getDb(databaseIdForRegion(ctx.region));
  const query = db
    .collection("signups")
    .where("tenantId", "==", ctx.tenantId)
    .where("campaignId", "==", campaignId)
    .where("referralToken", "==", referrerToken)
    .limit(1);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    if (snap.empty) {
      return { credited: false, reason: "referrer-not-found" as const };
    }
    const doc = snap.docs[0]!;
    const data = doc.data();
    const current =
      typeof data.amountReferred === "number" ? data.amountReferred : 0;
    const newAmount = current + 1;
    tx.update(doc.ref, {
      amountReferred: newAmount,
      score: newAmount * spotsToMoveUponReferral,
    });
    return {
      credited: true,
      reason: "ok" as const,
      referrerId: doc.id,
      newAmountReferred: newAmount,
    };
  });
}
