import { featureByPath, isStageId, type FeatureSlug, type StageId } from "./content";
import { isSiteLanguagesEnabled, isSiteLoopEnabled } from "./flags";
import { isOtherLang, type SiteLang } from "./langs";

/**
 * Resolve the route params of a loop-site page, or null when the page does not
 * exist here (unknown language, stage or feature, or its switch is off).
 */
export function resolveLang(lang?: string): SiteLang | null {
  if (!isSiteLoopEnabled()) return null;
  if (lang === undefined) return "en";
  return isSiteLanguagesEnabled() && isOtherLang(lang) ? lang : null;
}

export function resolveStage(lang: string | undefined, stage: string): { lang: SiteLang; id: StageId } | null {
  const l = resolveLang(lang);
  return l && isStageId(stage) ? { lang: l, id: stage } : null;
}

export function resolveFeature(lang: string | undefined, path: string): { lang: SiteLang; slug: FeatureSlug } | null {
  const l = resolveLang(lang);
  const slug = featureByPath(path);
  return l && slug ? { lang: l, slug } : null;
}
