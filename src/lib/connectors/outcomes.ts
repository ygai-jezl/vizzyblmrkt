import { bareHost } from "@/lib/content/blog/freshnessPages";
import type { MeaningKey } from "@/lib/metrics/meanings";
import { OUTCOME_KINDS, OUTCOMES, connectionHref, givesSource, outcomeCoverage, type CoverageConnection, type KindCoverage, type OutcomeKind, type OutcomeSource } from "@/lib/metrics/outcomes";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";
import { readByUse, type UseDeps, type UseRead, type UseResult, type UseRow } from "./byUse";
import { feedsPlanning } from "./grants";
import { pageKey } from "./keys";
import { LIVE_LIMITS, type ConnectorManifest } from "./manifest";
import { cleanPagePath } from "./paths";
import { listConnectors } from "./registry";

/**
 * The kinds of result a brand's article pages had, from whatever it has connected
 * (STRATEGY_RESULTS_ENABLED, ADR-0019). For each kind (src/lib/metrics/outcomes.ts), the first source
 * in order that a shared connection gives is read through readByUse, by page over the last 28 days,
 * and its rows are joined to the brand's live article pages. One connection supplies each kind, so
 * nothing is counted twice: of several, the one that matched the most article pages.
 *
 * - The brand comes only from ctx: connections are read through forTenant, so another brand's are
 *   never seen, and readByUse reads only connections both members and Vizzy may read.
 * - A read is capped at LIVE_LIMITS.maxRows rows a connection (the top pages the tool lists), and
 *   `more` names each kind whose read had more rows than that, so its numbers may be low.
 * - A kind read for the whole site only (Cloudflare's visits) is never split by page: it is a site
 *   total in `site`.
 * - A read that fails leaves that kind out with its code; it never stops the other kinds.
 */

export interface OutcomePage {
  /** The page's key as articlePageKey writes it: host and path. */
  key: string;
  url: string;
}

export interface OutcomeRead {
  coverage: KindCoverage[];
  /** Each article page's numbers, by meaning, from the one connection each kind was read from. */
  byPage: Record<string, Partial<Record<MeaningKey, number>>>;
  /** Totals for kinds read for the whole site only. */
  site: Partial<Record<MeaningKey, number>>;
  /** Kinds whose read was capped: the tool has more rows than were read. */
  more: OutcomeKind[];
  /** The days each measured kind's numbers cover, in the tool's own zone. */
  periods: Partial<Record<OutcomeKind, { from: string; to: string }>>;
  /** Connections whose read failed, with the code. */
  failed: Array<{ kind: OutcomeKind; connectionId: string; code: string }>;
}

export interface OutcomeDeps extends Omit<UseDeps, "job"> {
  /** The connectors offered in this build (registry.ts listConnectors; tests pass their own). */
  catalog?: () => readonly ConnectorManifest[];
  /** The reader by kind of data (tests pass their own). */
  read?: (ctx: TenantContext, use: OutcomeSource["use"], ask: Parameters<typeof readByUse>[2], deps: UseDeps) => Promise<UseResult>;
}

/** The most connections looked at, as readByUse looks at. */
const MAX_CONNECTIONS = 50;

/** An account's host when it is a site (a domain, a URL prefix or a "sc-domain:" property), else null (a property or zone id). */
export function hostOfAccount(account: string): string | null {
  const host = account.trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? bareHost(host) : null;
}

const hostAndPath = (url: string): { host: string; path: string } | null => {
  try {
    const u = new URL(url);
    return { host: bareHost(u.hostname), path: cleanPagePath(u.pathname) };
  } catch {
    return null;
  }
};

/**
 * A joiner from a connection's page rows to the brand's article pages. Pure. A row matches by host
 * and path when it knows its host (its own, a full address, or the account's when the account is a
 * site); otherwise by path alone, and only when one article has that path (on the account's site,
 * or its subdomains, when the account is one). A row that matches nothing is left out.
 */
export function pageJoiner(pages: readonly OutcomePage[]): (row: Pick<UseRow, "keys">, account: string) => string | null {
  const keys = new Set(pages.map((p) => p.key));
  const byPath = new Map<string, Array<{ key: string; host: string }>>();
  for (const p of pages) {
    const hp = hostAndPath(p.url);
    if (!hp) continue;
    byPath.set(hp.path, [...(byPath.get(hp.path) ?? []), { key: p.key, host: hp.host }]);
  }
  return (row, account) => {
    const raw = (row.keys.page ?? "").trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      const hp = hostAndPath(raw);
      const k = hp ? pageKey(hp.host, hp.path) : null;
      return k && keys.has(k) ? k : null;
    }
    const own = (row.keys.host ?? "").trim();
    if (own) {
      const k = pageKey(bareHost(own), raw);
      return keys.has(k) ? k : null;
    }
    const site = hostOfAccount(account);
    if (site) {
      const k = pageKey(site, raw);
      if (keys.has(k)) return k;
    }
    const near = (byPath.get(cleanPagePath(raw)) ?? []).filter((p) => !site || p.host === site || p.host.endsWith(`.${site}`));
    return near.length === 1 ? near[0]!.key : null;
  };
}

const coverageOf = (c: DataConnection): CoverageConnection => ({ id: c.id, connectorId: c.connectorId, status: c.status, account: c.account, grants: c.grants, createdAt: c.createdAt, health: c.health ? { state: c.health.state } : null });

/** The brand's connections as coverage needs them: never their secrets. */
export async function coverageConnections(ctx: TenantContext, deps: Pick<UseDeps, "db"> = {}): Promise<CoverageConnection[]> {
  const all = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: MAX_CONNECTIONS });
  return all.map(coverageOf);
}

/** What each kind of result can be measured from now, without reading any numbers. */
export async function liveCoverage(ctx: TenantContext, deps: Pick<OutcomeDeps, "db" | "catalog"> = {}): Promise<KindCoverage[]> {
  return outcomeCoverage(await coverageConnections(ctx, deps), (deps.catalog ?? listConnectors)());
}

/**
 * The kinds of result on the brand's live article pages over the last 28 days. `pages` are the
 * brand's own live articles (freshnessPages.ts liveArticles). Never throws for one kind's failure.
 */
export async function readOutcomes(ctx: TenantContext, pages: readonly OutcomePage[], deps: OutcomeDeps = {}): Promise<OutcomeRead> {
  const catalog = (deps.catalog ?? listConnectors)();
  const manifests = new Map(catalog.map((m) => [m.id, m] as const));
  const connections = await coverageConnections(ctx, deps);
  const accounts = new Map(connections.map((c) => [c.id, c.account] as const));
  const read = deps.read ?? readByUse;
  const useDeps: UseDeps = { ...deps, job: "strategy_month", manifestOf: deps.manifestOf ?? ((id) => manifests.get(id) ?? null) };
  const join = pageJoiner(pages);
  const matched: Record<string, number> = {};
  const failed: OutcomeRead["failed"] = [];
  /** Each connection's read, by the source it was read for. */
  const got = new Map<string, { read: UseRead; source: OutcomeSource }>();
  const readKey = (connectionId: string, s: OutcomeSource) => `${connectionId}|${s.use}|${s.by}|${s.measures.join(",")}`;

  /** One kind: the first source a shared, working connection gives, then the next only if every read of it failed. */
  const readKind = async (kind: OutcomeKind) => {
    for (const source of OUTCOMES[kind].sources) {
      const candidates = connections.filter((c) => c.account && feedsPlanning(c.grants) && c.health?.state !== "broken" && manifests.has(c.connectorId) && givesSource(manifests.get(c.connectorId)!, source));
      if (!candidates.length) continue;
      const ids = new Set(candidates.map((c) => c.id));
      let result: UseResult;
      try {
        result = await read(ctx, source.use, { measures: source.measures, by: source.by, period: "last_28_days", limit: LIVE_LIMITS.maxRows }, useDeps);
      } catch {
        for (const c of candidates) failed.push({ kind, connectionId: c.id, code: "failed" });
        continue;
      }
      for (const f of result.failed) if (ids.has(f.connectionId)) failed.push({ kind, connectionId: f.connectionId, code: f.code });
      const reads = result.reads.filter((r) => ids.has(r.connectionId));
      for (const r of reads) {
        got.set(readKey(r.connectionId, source), { read: r, source });
        if (!source.siteOnly) {
          const account = accounts.get(r.connectionId) ?? "";
          matched[r.connectionId] = Math.max(matched[r.connectionId] ?? 0, new Set(r.rows.map((row) => join(row, account)).filter(Boolean)).size);
        }
      }
      if (reads.length) return;
    }
  };
  await Promise.all(OUTCOME_KINDS.map((k) => readKind(k).catch(() => undefined)));

  const hitOf = (c: Extract<KindCoverage, { state: "measured" }>) => [...got.values()].find((g) => g.read.connectionId === c.connectionId && g.source.measures[0] === c.measure);
  // Each kind chooses among the connections that answered it: one that failed for this kind is left out of it alone.
  const coverage = OUTCOME_KINDS.map((kind, i): KindCoverage => {
    const c = outcomeCoverage(connections, catalog, { matched, failed: failed.filter((f) => f.kind === kind).map((f) => f.connectionId) })[i]!;
    // Measured, but no read of its source came back this time: it failed.
    if (c.state !== "measured" || hitOf(c)) return c;
    return { kind, state: "failed", connectionId: c.connectionId, connectorId: c.connectorId, connector: c.connector, href: connectionHref(c.connectionId) };
  });

  const out: OutcomeRead = { coverage, byPage: {}, site: {}, more: [], periods: {}, failed };
  for (const c of coverage) {
    if (c.state !== "measured") continue;
    const hit = hitOf(c);
    if (!hit) continue;
    const { read: r, source } = hit;
    if (r.more) out.more.push(c.kind);
    if (r.period) out.periods[c.kind] = { from: r.period.from, to: r.period.to };
    if (source.siteOnly) {
      for (const k of source.measures) out.site[k] = r.rows.reduce((t, row) => t + (typeof row.m[k] === "number" ? row.m[k]! : 0), 0);
      continue;
    }
    const account = accounts.get(r.connectionId) ?? "";
    for (const row of r.rows) {
      const key = join(row, account);
      if (!key) continue;
      const into = (out.byPage[key] ??= {});
      for (const k of source.measures) {
        const v = row.m[k];
        if (typeof v === "number" && Number.isFinite(v)) into[k] = (into[k] ?? 0) + v;
      }
    }
  }
  return out;
}
