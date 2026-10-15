import { createHash } from "node:crypto";
import type { JobEnv } from "./config";
import { MAX_PAGE_LINKS, type CrawledPage } from "./sources/web";

/**
 * The page records a crawl leaves beside its chunks. Keep the shape in sync with what the
 * app reads (`listKnowledgePages` in src/lib/tenant/knowledge.ts).
 */
export interface PageRecord {
  id: string;
  tenantId: string;
  ownerKind: JobEnv["ownerKind"];
  ownerId: string;
  ticketId: string;
  source: JobEnv["source"];
  url: string;
  title: string;
  path: string | null;
  links: string[];
  /** Its place in the crawl (0 = the address the source starts from). */
  pageIndex: number;
  createdAt: string;
}

/** The same page of the same source keeps its id across re-reads. */
export function pageRecordId(ticketId: string, url: string): string {
  return `${ticketId}__${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

export function pageRecords(
  pages: CrawledPage[],
  env: Pick<JobEnv, "tenantId" | "ownerKind" | "ownerId" | "ticketId" | "source">,
  at: string,
): PageRecord[] {
  const seen = new Set<string>();
  const out: PageRecord[] = [];
  for (const p of pages) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    let path: string | null = null;
    try {
      path = new URL(p.url).pathname;
    } catch {
      continue; // not an address: not a page
    }
    out.push({
      id: pageRecordId(env.ticketId, p.url),
      tenantId: env.tenantId,
      ownerKind: env.ownerKind,
      ownerId: env.ownerId,
      ticketId: env.ticketId,
      source: env.source,
      url: p.url,
      title: p.title.replace(/\s+/g, " ").trim().slice(0, 300),
      path,
      links: [...new Set(p.links)].filter((l) => l !== p.url).slice(0, MAX_PAGE_LINKS),
      pageIndex: out.length,
      createdAt: at,
    });
  }
  return out;
}
