import { eraseHistory, forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";

/** A company's id: `co_` and its hash (deterministicCompanyId). */
const COMPANY_ID = /^co_[0-9a-f]{16,64}$/;

/**
 * Remove company (RAISE_PASTE_ENABLED; the route checks the switch and the admin role): a company
 * with no people goes, its own field values with it (they sit on the document), and its history
 * (the events about it and the agent actions aimed at it). A firm added from a pasted list has no
 * people until someone there is added, so this is its way out. A company with people goes when
 * its last person is erased (src/lib/crm/eraseWorker.ts), never here.
 */
export async function removeCompany(
  ctx: TenantContext,
  companyId: string,
  deps: { db?: FirestoreLike } = {},
): Promise<{ ok: true; events: number; agentActions: number } | { ok: false; error: "not_found" | "has_people" }> {
  const repo = forTenant(ctx, deps.db);
  if (!COMPANY_ID.test(companyId) || !(await repo.companies.getById(companyId))) return { ok: false, error: "not_found" };
  if ((await repo.contacts.count([["companyId", "==", companyId]])) > 0) return { ok: false, error: "has_people" };
  await repo.companies.delete(companyId);
  const history = await eraseHistory(ctx, { recordKey: `company:${companyId}` }, { db: deps.db });
  return { ok: true, ...history };
}
