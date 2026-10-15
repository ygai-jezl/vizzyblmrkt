import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BlogBrief, BlogEntity, ContentPlan } from "@/lib/types/contentPlan";
import { BrandMapChangeSchema, type BrandMap } from "@/lib/types/brandMap";
import { decidedBrandMap, fileBrandMapSuggestions, type SuggestionInput } from "@/lib/brandMap/store";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { planPageId, type BrandMapPage } from "@/lib/types/brandMapPage";
import { projectArticleMap, reconcileMapRefs, type ArticleMap } from "./articleMap";
import { computeCoverage } from "./coverage";
import { isBlogBrandMapEnabled } from "./flags";

/**
 * Where an article meets the brand map on the server: reading the map it is written from,
 * and filing what it found that the map does not have. Both are soft: a slow or failing map
 * never holds up or fails the article.
 */

export interface MapDeps {
  db?: FirestoreLike;
  /** The saved map (tests inject one). */
  loadMap?: (ctx: TenantContext, db?: FirestoreLike) => Promise<BrandMap | null>;
  /** The brand's page rows (tests inject them). */
  listPages?: (ctx: TenantContext, db?: FirestoreLike) => Promise<BrandMapPage[]>;
}

/**
 * The map an article is written from, or null (flag off, none saved, or unreadable) — then it
 * is written as before. With `pages` (research) and the pages switch on, it also carries which
 * map questions are answered and the live articles on each subject, read beside the map.
 */
export async function loadArticleMap(
  ctx: TenantContext,
  deps: MapDeps = {},
  opts: { pages?: boolean; /** The article asking: its own row never answers its own questions. */ planId?: string } = {},
): Promise<ArticleMap | null> {
  if (!isBlogBrandMapEnabled()) return null;
  const withPages = Boolean(opts.pages) && isBrandMapPagesEnabled();
  const [map, read] = await Promise.all([
    (deps.loadMap ?? decidedBrandMap)(ctx, deps.db).catch(() => null),
    // A slow read of the pages never holds research up: without them, nothing is answered.
    withPages ? softly("reading the brand's pages", () => (deps.listPages ?? listBrandMapPages)(ctx, deps.db), PAGES_MS) : Promise.resolve(null),
  ]);
  if (!map) return null;
  const article = projectArticleMap(map);
  const own = opts.planId ? planPageId(opts.planId) : null;
  const rows = (read ?? []).filter((r) => r.id !== own);
  if (!rows.length) return article;
  const coverage = computeCoverage(article, rows);
  return { ...article, answered: coverage.answered, siblings: coverage.siblings };
}

/** How long an article's research waits for the brand's pages. */
const PAGES_MS = 3_000;

/** Run a best-effort side job, waiting at most `ms`. A failure is logged, never thrown. */
export async function softly<T>(label: string, work: () => Promise<T>, ms = 2_000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch (err) {
    console.warn(`[brand-map] ${label} failed`, err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const KIND_OF: Partial<Record<BlogEntity["relation"], "product" | "alternative" | "integration" | "audience" | "use_case">> = {
  product: "product",
  alternative: "alternative",
  integration: "integration",
  audience: "audience",
  use_case: "use_case",
};

/** Names an article uses that the map does not have, as suggestions for it. */
export function articleSuggestions(plan: Pick<ContentPlan, "id" | "workspaceId" | "name">, unknown: BlogEntity[], title?: string): SuggestionInput[] {
  const items: SuggestionInput[] = [];
  for (const e of unknown) {
    const kind = KIND_OF[e.relation];
    if (!kind) continue;
    const change = BrandMapChangeSchema.safeParse({ type: "add_name", name: e.name, kind });
    if (!change.success) continue;
    items.push({
      change: change.data,
      reason: "Named in an article",
      evidence: "articles",
      ref: { workspaceId: plan.workspaceId, planId: plan.id, title: (title || plan.name).slice(0, 200) },
    });
  }
  return items;
}

/** File an article's new names for the map (best-effort: never fails the article). */
export async function fileArticleSuggestions(
  ctx: TenantContext,
  args: { plan: Pick<ContentPlan, "id" | "workspaceId" | "name">; unknown: BlogEntity[]; title?: string },
  deps: { db?: FirestoreLike } = {},
): Promise<number> {
  const items = articleSuggestions(args.plan, args.unknown, args.title);
  if (!items.length) return 0;
  const filed = await softly("filing an article's names", () => fileBrandMapSuggestions(ctx, { from: "article", items }, { db: deps.db }));
  return filed && filed.ok ? filed.value.filed.length : 0;
}

/**
 * A new article's subject and map question, checked against the saved map (a plan made in the
 * wizard or by Vizzy names them by id). Without a map they can't be right, so they go.
 */
export async function reconcileWithSavedMap<B extends Pick<BlogBrief, "subjectId" | "primaryRef">>(ctx: TenantContext, brief: B, deps: MapDeps = {}): Promise<B> {
  if (brief.subjectId === undefined && brief.primaryRef === undefined) return brief;
  const map = await loadArticleMap(ctx, deps);
  if (map) return reconcileMapRefs(brief, map, { newArticle: true });
  const next = { ...brief };
  delete next.subjectId;
  delete next.primaryRef;
  return next;
}
