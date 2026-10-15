import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { forTenant } from "@/lib/tenant";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";

/**
 * At most this many page rows are read. Ids sort articles (p_) before pages already on the
 * site (s_), so a large site never pushes the articles out.
 */
export const MAX_PAGE_ROWS = 600;

/** The brand's page rows (BRAND_MAP_PAGES_ENABLED). A row that no longer parses is left out. */
export async function listBrandMapPages(ctx: TenantContext, db?: FirestoreLike): Promise<BrandMapPage[]> {
  const docs = await forTenant(ctx, db).brandMapPages.find({ limit: MAX_PAGE_ROWS });
  return docs.flatMap((d) => {
    const parsed = BrandMapPageSchema.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });
}
