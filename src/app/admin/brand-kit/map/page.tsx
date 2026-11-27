import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant, getTenantById } from "@/lib/tenant";
import { isBlogBrandMapEnabled } from "@/lib/content/blog/flags";
import { BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import {
  isBlogFreshnessEnabled,
  isBrandMapEnabled,
  isBrandMapImportEnabled,
  isBrandMapPagesEnabled,
  isBrandMapResearchEnabled,
  isBrandMapScaleEnabled,
  isBrandMapSituationAskEnabled,
  isBrandMapSituationsEnabled,
  isBrandMapWikidataEnabled,
} from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { computeCoverage } from "@/lib/content/blog/coverage";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import { isMapSaved } from "@/lib/types/brandMap";
import { isGeminiConfigured } from "@/lib/agents/gemini";
import { isCompetitorArticlesPlanningEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors } from "@/lib/competitors/store";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { readBrandMap, type BrandMapRead } from "@/lib/brandMap/store";
import { BrandMapEditor } from "@/components/admin/brand-kit/BrandMapEditor";
import { AutopilotPanel } from "@/components/admin/autopilot/AutopilotPanel";
import { RefreshClockCard } from "@/components/admin/autopilot/RefreshClockCard";
import { isAutopilotEnabled, isNextUpEnabled } from "@/lib/autopilot/flags";
import { BrandMapTabs } from "@/components/admin/brand-kit/BrandMapTabs";
import { BrandMapContentMap } from "@/components/admin/brand-kit/BrandMapContentMap";
import { BrandMapContentMapLevels } from "@/components/admin/brand-kit/BrandMapContentMapLevels";
import { BrandMapMoveProvider } from "@/components/admin/brand-kit/brandMapMove";
import { BrandMapSituations } from "@/components/admin/brand-kit/BrandMapSituations";
import { BrandMapImport } from "@/components/admin/brand-kit/BrandMapImport";
import { BrandMapSubjectsTab } from "@/components/admin/brand-kit/BrandMapSubjectsTab";
import { BrandMapStrategy } from "@/components/admin/brand-kit/BrandMapStrategy";
import { isBrandStrategyEnabled, isStrategyCheckEnabled } from "@/lib/brandStrategy/flags";
import { isContentStrategyEnabled } from "@/lib/contentStrategy/flags";
import { homesOf, mapPageOf } from "@/lib/brandMap/contentMapLayout";
import { decidedOf } from "@/components/admin/brand-kit/brandMapForm";

export const dynamic = "force-dynamic";

/**
 * Brand › Brand map (BRAND_MAP_ENABLED): one set of names and subjects that every blog
 * article is written from. Members can view it; only admins save it, accept or dismiss a
 * suggestion, run research or look up an identifier.
 */
export default async function BrandMapPage({ searchParams }: { searchParams?: Promise<{ tab?: string }> }) {
  const ctx = await requireAdminContext();
  if (!isBrandMapEnabled()) notFound();

  const pagesOn = isBrandMapPagesEnabled();
  // The map at any size: subjects on their own tab, read a group and a subject at a time.
  const scale = isBrandMapScaleEnabled();
  // Buying situations (implies the map at any size): a tab of their own.
  const situations = isBrandMapSituationsEnabled();
  // "Find what they ask" on one situation (implies situations and research).
  const askOn = isBrandMapSituationAskEnabled();
  // "Write this next" needs articles written from the map, and somewhere to write them.
  const writeNextOn = pagesOn && isBlogBrandMapEnabled();
  const [read, tenant, pages, workspaces] = await Promise.all([
    readBrandMap(ctx).catch((err): BrandMapRead => {
      console.error("[brand-map] read failed", err);
      return { state: "none" };
    }),
    getTenantById(ctx.tenantId).catch(() => null),
    pagesOn && !scale
      ? listBrandMapPages(ctx).catch((err): BrandMapPage[] => {
          console.error("[brand-map] pages read failed", err);
          return [];
        })
      : ([] as BrandMapPage[]),
    writeNextOn ? forTenant(ctx).workspaces.find({ where: [], limit: 200 }).catch(() => []) : [],
  ]);
  const map = read.state === "ok" ? read.map : null;
  // What the brand's pages answer, worked out now from the saved map (never stored).
  const coverage = pagesOn && !scale && map && isMapSaved(map) ? computeCoverage(map, pages) : null;
  const programmes = writeNextOn ? workspaces.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name })) : null;
  const root = tenant?.rootDomain?.trim();
  // Competitors: the ones watched, for Monitor and Monitoring on the alternatives.
  const competitors =
    isCompetitorsEnabled() && (await brandCanUse(ctx, "competitors").catch(() => false))
      ? await listCompetitors(ctx)
          .then((list) => list.map((c) => ({ id: c.id, name: c.name })))
          .catch(() => [])
      : null;

  // What competitors wrote, on each subject's panel.
  const competitorArticles =
    competitors !== null && isCompetitorArticlesPlanningEnabled() && (await brandCanUse(ctx, "competitor_articles").catch(() => false));

  const nextUp = isNextUpEnabled() && map !== null && (await brandCanUse(ctx, "next_up").catch(() => false));
  // The brand strategy (BRAND_STRATEGY_ENABLED): its own tab, hidden while the switch is off. Its
  // Content plan section (CONTENT_STRATEGY_ENABLED) shows only with that switch on too.
  const strategy = isBrandStrategyEnabled()
    ? [{ id: "strategy", label: "Strategy", node: <BrandMapStrategy canEdit={ctx.role === "admin"} contentPlan={isContentStrategyEnabled()} canAsk={askOn && isGeminiConfigured()} /> }]
    : [];
  // Review the strategy, from the weekly check's row in Review (STRATEGY_CHECK_ENABLED), opens its tab.
  const openTab = isStrategyCheckEnabled() && strategy.length && (await searchParams)?.tab === "strategy" ? "strategy" : undefined;
  const tabs = (
    <BrandMapTabs
      initialTab={openTab}
      editor={
        <BrandMapEditor
          initial={decidedOf(map)}
          rev={map?.rev ?? 0}
          suggestions={map?.suggestions ?? []}
          research={map?.research ?? null}
          unreadable={read.state === "unreadable"}
          canEdit={ctx.role === "admin"}
          canResearch={isBrandMapResearchEnabled() && isGeminiConfigured()}
          canLookup={isBrandMapWikidataEnabled()}
          defaults={{ name: tenant?.tenantName?.trim() ?? "", site: root ? `https://${root.replace(/^https?:\/\//, "")}` : "" }}
          coverage={coverage}
          programmes={programmes}
          scale={scale}
          recordsDecided={Boolean(map?.recordsDecidedAt)}
          competitors={competitors}
        />
      }
      editorLabel={scale ? "Who you are" : undefined}
      extra={
        scale
          ? [
              ...(situations
                ? [
                    {
                      id: "situations",
                      label: "Buying situations",
                      node: (
                        <BrandMapSituations
                          canEdit={ctx.role === "admin"}
                          canFind={isBrandMapResearchEnabled() && isGeminiConfigured()}
                          askOn={askOn}
                          canAsk={askOn && isGeminiConfigured()}
                          brandName={map?.identity.name || tenant?.tenantName?.trim() || ""}
                          programmes={programmes}
                        />
                      ),
                    },
                  ]
                : []),
              { id: "subjects", label: "Subjects", node: <BrandMapSubjectsTab canEdit={ctx.role === "admin"} programmes={programmes} ungroupedTotals={map?.ungroupedTotals ?? null} competitorArticles={competitorArticles} /> },
              ...(isBrandMapImportEnabled() ? [{ id: "research", label: "Your research", node: <BrandMapImport canEdit={ctx.role === "admin"} programmes={programmes} /> }] : []),
              ...strategy,
            ]
          : strategy
      }
      contentMap={
        scale ? (
          pagesOn && map ? (
            <BrandMapContentMapLevels
              brand={{ name: map.identity.name, statement: map.identity.statement }}
              // A subject's own page is added when it is open.
              homes={homesOf({ identity: map.identity, names: map.names, subjects: [] })}
              programmes={programmes}
              situations={situations}
            />
          ) : null
        ) : coverage && map ? (
          <BrandMapContentMap
            input={{ brand: { name: map.identity.name, statement: map.identity.statement }, coverage, pages: pages.map(mapPageOf), homes: homesOf(map) }}
            programmes={programmes}
          />
        ) : null
      }
    />
  );

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Brand map</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">One set of names and subjects. Every article is written from it.</p>
      </div>
      {nextUp ? <AutopilotPanel isAdmin={ctx.role === "admin"} programmes={programmes} autopilot={isAutopilotEnabled()} /> : null}
      {isBlogFreshnessEnabled() ? <RefreshClockCard isAdmin={ctx.role === "admin"} /> : null}
      {scale ? (
        // The first time an admin opens the page, whichever tab shows, the subjects move into their records;
        // until a read of the brand's pages and a count has run to the end, it starts again.
        <BrandMapMoveProvider
          canMove={ctx.role === "admin" && read.state !== "unreadable"}
          moved={Boolean(map?.moved)}
          readPages={pagesOn}
          pagesRead={Boolean(map?.pagesReadAt)}
        >
          {tabs}
        </BrandMapMoveProvider>
      ) : (
        tabs
      )}
    </div>
  );
}
