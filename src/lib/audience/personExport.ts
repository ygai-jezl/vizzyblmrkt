import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isPersonId } from "./paths";

/**
 * Everything YouGrow holds about one product user, as the stored documents — for
 * a data subject access request. It reads exactly what an erasure deletes
 * (src/lib/connect/erase.ts: profile, product events, journey progress, email
 * engagement, AI drafts, their plan) plus their opt-outs, so the two stay in
 * step: a store added to one belongs in the other.
 *
 * It reads up to a limit of each kind. `complete` says whether every section came
 * back short of its limit; when one didn't, `truncated` names it, so a file that
 * isn't everything never passes for everything.
 */

/** Our own working fields: leases and Firestore TTLs say nothing about the person. */
const INTERNAL = new Set(["tenantId", "ttlAt", "leaseId", "leaseUntil", "prepareLeaseUntil", "pendingSend", "previewHtml"]);

function plain<T extends object>(doc: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !INTERNAL.has(k)));
}

export const PERSON_EXPORT_FORMAT = "yougrow.person";

/** The most rows of each kind one export reads. A section that reaches its limit is named in `truncated`. */
const EXPORT_LIMITS = { productEvents: 2000, journeys: 200, emailEngagement: 5000, aiLines: 200, optOuts: 200, plans: 10 } as const;
type Section = keyof typeof EXPORT_LIMITS;

export async function exportPerson(
  ctx: TenantContext,
  personId: string,
  deps: { db?: FirestoreLike; nowMs?: number; limits?: Partial<Record<Section, number>> } = {},
): Promise<{ found: false } | { found: true; document: Record<string, unknown> }> {
  if (!isPersonId(personId)) return { found: false };
  const repo = forTenant(ctx, deps.db);
  const user = await repo.productUsers.getById(personId);
  if (!user || user.status !== "active") return { found: false };
  const limit = (section: Section) => deps.limits?.[section] ?? EXPORT_LIMITS[section];
  const mine = { where: [["productUserId", "==", user.id]] as WhereClause[] };
  const [productEvents, journeys, emailEngagement, aiLines, optOuts, plans] = await Promise.all([
    repo.productEvents.find({ ...mine, limit: limit("productEvents") }),
    repo.lifecycleEnrolments.find({ ...mine, limit: limit("journeys") }),
    repo.emailEvents.find({ where: [["signupId", "==", user.id]], limit: limit("emailEngagement") }),
    repo.lifecycleDrafts.find({ ...mine, limit: limit("aiLines") }),
    user.emailNormalized ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: limit("optOuts") }) : Promise.resolve([]),
    repo.personPlans.find({ ...mine, limit: limit("plans") }),
  ]);
  const sections = { productEvents, journeys, emailEngagement, aiLines, optOuts, plans };
  // A section that came back full may have more behind it: the file says so, never passes for the whole.
  const truncated = (Object.keys(sections) as Section[]).filter((name) => sections[name].length >= limit(name));
  return {
    found: true,
    document: {
      format: PERSON_EXPORT_FORMAT,
      exportedAt: new Date(deps.nowMs ?? Date.now()).toISOString(),
      complete: truncated.length === 0,
      ...(truncated.length
        ? { truncated: Object.fromEntries(truncated.map((name) => [name, `only the first ${limit(name)} are here: there may be more`])) }
        : {}),
      profile: plain(user),
      productEvents: productEvents.map(plain),
      journeys: journeys.map(plain),
      emailEngagement: emailEngagement.map(plain),
      aiLines: aiLines.map(plain),
      optOuts: optOuts.map(plain),
      plans: plans.map(plain),
    },
  };
}
