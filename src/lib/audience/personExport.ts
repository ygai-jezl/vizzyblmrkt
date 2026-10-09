import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * Everything YouGrow holds about one product user, as the stored documents — for
 * a data subject access request. It reads exactly what an erasure deletes
 * (src/lib/connect/erase.ts: profile, product events, journey progress, email
 * engagement, AI drafts, their plan) plus their opt-outs, so the two stay in
 * step: a store added to one belongs in the other.
 */

/** Our own working fields: leases and Firestore TTLs say nothing about the person. */
const INTERNAL = new Set(["tenantId", "ttlAt", "leaseId", "leaseUntil", "prepareLeaseUntil", "pendingSend", "previewHtml"]);

function plain<T extends object>(doc: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !INTERNAL.has(k)));
}

export const PERSON_EXPORT_FORMAT = "yougrow.person";

export async function exportPerson(
  ctx: TenantContext,
  personId: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ found: false } | { found: true; document: Record<string, unknown> }> {
  const repo = forTenant(ctx, deps.db);
  const user = await repo.productUsers.getById(personId);
  if (!user || user.status !== "active") return { found: false };
  const [events, enrolments, emailEvents, drafts, optOuts, plans] = await Promise.all([
    repo.productEvents.find({ where: [["productUserId", "==", user.id]], limit: 2000 }),
    repo.lifecycleEnrolments.find({ where: [["productUserId", "==", user.id]], limit: 200 }),
    repo.emailEvents.find({ where: [["signupId", "==", user.id]], limit: 5000 }),
    repo.lifecycleDrafts.find({ where: [["productUserId", "==", user.id]], limit: 200 }),
    user.emailNormalized ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: 200 }) : Promise.resolve([]),
    repo.personPlans.find({ where: [["productUserId", "==", user.id]], limit: 10 }),
  ]);
  return {
    found: true,
    document: {
      format: PERSON_EXPORT_FORMAT,
      exportedAt: new Date(deps.nowMs ?? Date.now()).toISOString(),
      profile: plain(user),
      productEvents: events.map(plain),
      journeys: enrolments.map(plain),
      emailEngagement: emailEvents.map(plain),
      aiLines: drafts.map(plain),
      optOuts: optOuts.map(plain),
      plans: plans.map(plain),
    },
  };
}
