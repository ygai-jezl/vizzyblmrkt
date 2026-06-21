import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { WhereClause } from "@/lib/tenant/repository";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import { queryToken } from "@/lib/crm/searchTokens";

export const CRM_PAGE_SIZE = 50;

export interface ListContactsParams {
  q?: string;
  campaignId?: string;
  corporate?: boolean;
  enriched?: boolean;
  /** Keyset cursor: the createdAt of the last row of the previous page. */
  cursor?: string;
  limit?: number;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * List contacts for the CRM Contacts tab. Firestore allows only ONE
 * array-contains and limited multi-field composites, so we apply a single
 * primary filter server-side (indexed) ordered by createdAt, and let the caller
 * refine the rest client-side over the page. Keyset pagination via createdAt.
 */
export async function listContacts(
  ctx: TenantContext,
  params: ListContactsParams = {},
): Promise<ListResult<Contact>> {
  const limit = Math.min(params.limit ?? CRM_PAGE_SIZE, 200);
  const where: WhereClause[] = [];
  const token = params.q ? queryToken(params.q) : "";
  // Primary filter precedence (each backed by a (tenantId, X, createdAt) index).
  if (token) where.push(["searchTokens", "array-contains", token]);
  else if (params.campaignId) where.push(["campaignIds", "array-contains", params.campaignId]);
  else if (params.enriched) where.push(["enrichment.status", "==", "enriched"]);
  else if (params.corporate) where.push(["isCorporateDomain", "==", true]);

  const rows = await forTenant(ctx).contacts.find({
    where,
    orderBy: [["createdAt", "desc"]],
    startAfter: params.cursor ? [params.cursor] : undefined,
    limit: limit + 1,
  });
  return paginate(rows, limit, (c) => c.createdAt);
}

export interface ListCompaniesParams {
  q?: string;
  cursor?: string; // updatedAt of the last row
  limit?: number;
}

/** List companies for the CRM Companies tab (newest activity first). */
export async function listCompanies(
  ctx: TenantContext,
  params: ListCompaniesParams = {},
): Promise<ListResult<Company>> {
  const limit = Math.min(params.limit ?? CRM_PAGE_SIZE, 200);
  const where: WhereClause[] = [];
  const token = params.q ? queryToken(params.q) : "";
  if (token) where.push(["searchTokens", "array-contains", token]);

  const rows = await forTenant(ctx).companies.find({
    where,
    orderBy: [["updatedAt", "desc"]],
    startAfter: params.cursor ? [params.cursor] : undefined,
    limit: limit + 1,
  });
  return paginate(rows, limit, (c) => c.updatedAt);
}

function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string): ListResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? cursorOf(items[items.length - 1]!) : null;
  return { items, nextCursor };
}
