import { forTenant, listKnowledgePages, verifyOwner } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { KnownPage } from "@/lib/content/blog/links";
import { isCiteSource, isCiteSourcesEnabled, isWebSource } from "./cite";

/**
 * The pages a programme has indexed: the pages of the sites it crawled, the files of the
 * repos it connected, and (with cite sources on) the pages of its cite sources. Blog
 * research reads these for the brand's own pages to link to; the brand map reads them to
 * tell which page is the home of a subject or a name.
 */

/** Sources whose pages are listed: this many of the brand's own, this many cite sources. */
const MAX_SOURCES_LISTED = 8;

export interface SitePages {
  /** Pages of the brand's site that were crawled. */
  pages: KnownPage[];
  /** File paths from connected repos — a route may be read off some of them. */
  repoPaths: string[];
  /** Pages of the brand's cite sources (flag on). Whose each one is, its site decides,
   *  like any other page — but these never help decide WHICH site is the brand's. */
  cited?: KnownPage[];
}

export type ListedSource = Pick<IngestionTicket, "id" | "source" | "tags" | "status" | "chunksWritten" | "finishedAt" | "createdAt">;

/**
 * Which of a workspace's sources have their pages listed: the most recently read, a few
 * of them. With cite sources on, those are counted apart — a shelf of twenty studies
 * added last week must not push the brand's own site (read last year) off the list.
 */
export function sourcesToList<T extends ListedSource>(tickets: T[], citeOn = isCiteSourcesEnabled()): { own: T[]; cited: T[] } {
  const read = tickets
    .filter((t) => (t.status === "done" || t.status === "partial") && t.chunksWritten > 0)
    .sort((a, b) => (b.finishedAt ?? b.createdAt ?? "").localeCompare(a.finishedAt ?? a.createdAt ?? ""));
  if (!citeOn) return { own: read.slice(0, MAX_SOURCES_LISTED), cited: [] };
  const cite = (t: T) => isWebSource(t.source) && isCiteSource(t.tags);
  return {
    own: read.filter((t) => !cite(t)).slice(0, MAX_SOURCES_LISTED),
    cited: read.filter(cite).slice(0, MAX_SOURCES_LISTED),
  };
}

/** What the programme has indexed: the pages of crawled sites, and the files of connected repos. */
export async function indexedSitePages(ctx: TenantContext, workspaceId: string): Promise<SitePages> {
  const out: SitePages = { pages: [], repoPaths: [], cited: [] };
  if (!(await verifyOwner(ctx, "workspace", workspaceId))) return out;
  const { own, cited } = sourcesToList(
    await forTenant(ctx).ingestionTickets.find({
      where: [
        ["ownerKind", "==", "workspace"],
        ["ownerId", "==", workspaceId],
      ],
      limit: 200,
    }),
  );
  const list = (t: IngestionTicket, limit: number) =>
    listKnowledgePages(ctx, "workspace", workspaceId, { ticketId: t.id, limit }).catch(() => []);
  const [ownLists, citedLists] = await Promise.all([
    Promise.all(own.map(async (t) => ({ git: t.source === "github" || t.source === "gitlab", pages: await list(t, 600) }))),
    // A cite source is a page or a handful, not a site.
    Promise.all(cited.map((t) => list(t, 60))),
  ]);
  for (const l of ownLists) {
    for (const p of l.pages) {
      if (l.git) {
        if (p.path) out.repoPaths.push(p.path);
      } else {
        out.pages.push({ url: p.sourceUri, title: p.title });
      }
    }
  }
  for (const pages of citedLists) for (const p of pages) out.cited!.push({ url: p.sourceUri, title: p.title });
  return out;
}
