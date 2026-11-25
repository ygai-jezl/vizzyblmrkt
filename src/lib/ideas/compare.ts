import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { productNameOf } from "@/lib/connect/environments";
import { loadFunnel, type Funnel } from "@/lib/invites/funnel";
import { SUBJECT_ID } from "@/lib/ontology/events";
import type { Idea } from "@/lib/types/campaign";
import { COMPARE_MAX, COMPARE_MIN } from "./list";

export { COMPARE_MAX, COMPARE_MIN };

/**
 * Ideas side by side (LAUNCH_IDEAS_ENABLED, on the launches list): `?compare=a,b` or the repeated
 * `?compare=a&compare=b` a plain GET form sends. Two to four launches, each with its status,
 * hypothesis, outcome and loadFunnel's five numbers. Another brand's launch and one marked Just a
 * list are left out.
 */

/** The ids to compare, each once, or null when there aren't 2 to 4 good ones. */
export function parseCompareIds(raw: string | string[] | undefined): string[] | null {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const ids = [...new Set(values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean))];
  if (ids.length < COMPARE_MIN || ids.length > COMPARE_MAX) return null;
  return ids.every((id) => SUBJECT_ID.test(id)) ? ids : null;
}

export interface ComparedIdea {
  id: string;
  name: string;
  idea: Idea;
  archived: boolean;
  /** The product it was handed off to, by name, while that product is still connected. */
  handedOffTo: string | null;
  funnel: Funnel;
}

/** The launches to compare, in the order asked for, leaving out any that aren't this brand's or are Just a list. */
export async function loadComparison(ctx: TenantContext, ids: readonly string[], db?: FirestoreLike): Promise<ComparedIdea[]> {
  const repos = forTenant(ctx, db);
  const found = await Promise.all(ids.map((id) => repos.campaigns.getById(id).catch(() => null)));
  const kept = found.filter((c): c is NonNullable<typeof c> => !!c && !c.idea?.justAList);
  return Promise.all(
    kept.map(async (c) => {
      const productId = c.idea?.productConnectionId ?? null;
      const [funnel, product] = await Promise.all([
        loadFunnel(ctx, { campaignId: c.id }, db),
        productId ? repos.productConnections.getById(productId).catch(() => null) : null,
      ]);
      return {
        id: c.id,
        name: c.waitlistName,
        idea: c.idea ?? {},
        archived: !!c.archivedAt,
        handedOffTo: product && product.status !== "revoked" ? productNameOf(product) : null,
        funnel,
      };
    }),
  );
}
