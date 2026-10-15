import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapChange, BrandMapSuggestion } from "@/lib/types/brandMap";
import { isBrandMapScaleEnabled } from "./flags";

/** A suggestion about a subject: adding one, adding a question to one, a subject's home page. */
export const aboutSubjects = (c: BrandMapChange) => c.type === "add_subject" || c.type === "add_question" || (c.type === "set_home" && c.target === "subject");

/**
 * The suggestions on the brand's record a person can act on. At any size, those about
 * subjects became proposals on the records (and the page shows those instead), so they are
 * not counted twice.
 */
export function suggestionsWaiting(map: { suggestions: BrandMapSuggestion[] }): BrandMapSuggestion[] {
  return isBrandMapScaleEnabled() ? map.suggestions.filter((s) => !aboutSubjects(s.change)) : map.suggestions;
}

/**
 * Proposals waiting on a map at any size (BRAND_MAP_SCALE_ENABLED): subjects, questions,
 * buying situations and groups research, an import or Vizzy proposed, for the Review row and
 * Vizzy's card. One cheap count each. 0 with the switch off.
 */
export async function proposalsWaiting(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<number> {
  if (!isBrandMapScaleEnabled()) return 0;
  const store = brandMapRecords(ctx, deps.db);
  const counts = await Promise.all((["sub", "q", "sit", "grp"] as const).map((kind) => store.count(kind, [["status", "==", "proposed"]]).catch(() => 0)));
  return counts.reduce((a, b) => a + b, 0);
}
