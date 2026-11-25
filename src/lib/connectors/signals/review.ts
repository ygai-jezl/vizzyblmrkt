import { writeNextHref } from "@/lib/content/blog/articleMap";
import { liveArticleAt, refreshHref, signalPageKey } from "@/lib/content/blog/freshnessPages";
import { agentActionReviewItem, getAgentAction, listOpenAgentActions } from "@/lib/ontology/agentActions";
import { forgetReviewCount, type ReviewItem } from "@/lib/review/summary";
import { forTenant, getTenantById, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isAgentActionId, type AgentAction } from "@/lib/types/agentAction";
import type { DataConnection } from "@/lib/types/dataConnection";
import { isDataSignalId, type DataSignal } from "@/lib/types/dataSignal";
import type { Tenant } from "@/lib/types/tenant";
import { feedsPlanning } from "../grants";
import { readableOnly, type SourceDeps } from "../sources";
import { siteName } from "../keys";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { DATA_SIGNAL_ACTION, PROPOSE_QUESTION_ACTION, SIGNALS_AGENT } from "./names";
import { blankSignal, getSignal, QUIET_DAYS } from "./store";
import { signalLines, signalTitle } from "./words";

/**
 * Suggestions from collected numbers as people and Vizzy see them (Connectors 2 group 4,
 * CONNECTOR_SIGNALS_ENABLED): the open ones, each with its row and its connection, from
 * connections both members and Vizzy may read; Review's "What your numbers suggest" items; and the
 * two decisions an admin makes there.
 *
 * - Plan an article: the suggestion moves to acted with its link (the Create step with the
 *   question, the page or the search filled in), its values cleared, and its row blanked and kept
 *   away 30 days. The link kept on the action has no search words or page in it (agent actions
 *   have no time to live); the full one goes only to the person who pressed it.
 * - Dismiss: declined (dismissed), values cleared, the row blanked and kept away 30 days.
 * Both forget the cached Review count. The decision lives on the agent action only.
 */

export interface OpenSuggestion {
  action: AgentAction;
  row: DataSignal;
  connection: DataConnection;
}

export interface SuggestionDeps extends Pick<SourceDeps, "regionDb" | "controlDb"> {
  db?: FirestoreLike;
  now?: Date;
}

/**
 * The brand's connected Search Console connections that feed planning, by id: its own, and the
 * parts its organisation still gives it (partLive), so a brand that left sees none of its old
 * part's suggestions before the erase.
 */
export async function planningConnections(ctx: TenantContext, deps: SuggestionDeps): Promise<Map<string, DataConnection>> {
  const conns = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: 50 });
  const planning = await readableOnly(ctx, conns.filter((c) => c.connectorId === searchConsoleManifest.id && feedsPlanning(c.grants)), { db: deps.db, regionDb: deps.regionDb, controlDb: deps.controlDb });
  return new Map(planning.map((c) => [c.id, c] as const));
}

/**
 * The open suggestions (Review's, and with `brandMap` the questions proposed on the brand map
 * too), newest first, each with its row, from planning connections only. A blanked row, or one
 * whose connection no longer feeds planning, is left out.
 */
export async function openSuggestions(ctx: TenantContext, opts: { brandMap?: boolean } = {}, deps: SuggestionDeps = {}): Promise<OpenSuggestion[]> {
  const now = (deps.now ?? new Date()).toISOString();
  const kinds = opts.brandMap ? [DATA_SIGNAL_ACTION, PROPOSE_QUESTION_ACTION] : [DATA_SIGNAL_ACTION];
  const actions = (await Promise.all(kinds.map((action) => listOpenAgentActions(ctx, { action, limit: 50, now, db: deps.db })))).flat().filter((a) => a.agent === SIGNALS_AGENT);
  if (!actions.length) return [];
  const connections = await planningConnections(ctx, deps);
  const out: OpenSuggestion[] = [];
  for (const a of actions) {
    const signalId = a.signals.find((s) => s.kind === "data_signal")?.ref;
    const row = signalId ? await getSignal(ctx, signalId, deps) : null;
    const connection = row ? connections.get(row.connectionId) : undefined;
    if (!row || !row.label || !connection || row.gen !== connection.collect?.gen) continue;
    out.push({ action: a, row, connection });
  }
  return out.sort((x, y) => y.action.createdAt.localeCompare(x.action.createdAt));
}

/** The site to name in a suggestion's lines: only when the brand has more than one. */
export function siteFor(s: OpenSuggestion, all: readonly OpenSuggestion[]): string | undefined {
  const sites = new Set(all.map((x) => x.connection.id));
  return sites.size > 1 ? siteName(s.connection.account) : undefined;
}

/**
 * The brand's live article a "losing clicks" suggestion is about (BLOG_FRESHNESS_ENABLED), or null:
 * then the suggestion is to refresh it, not to plan a new one.
 */
async function ownArticleFor(ctx: TenantContext, row: DataSignal, connection: DataConnection, deps: SuggestionDeps): Promise<{ planId: string; workspaceId: string } | null> {
  if (row.rule !== "losing_page" || !row.label) return null;
  return liveArticleAt(ctx, signalPageKey(row.key?.host, connection.account, row.key?.page ?? row.label), { db: deps.db });
}

/** Review's "What your numbers suggest": one item per open suggestion, with Plan an article (or Refresh this article) and Dismiss. */
export async function signalReviewItems(ctx: TenantContext, deps: SuggestionDeps = {}): Promise<ReviewItem[]> {
  const open = await openSuggestions(ctx, {}, deps);
  const own = await Promise.all(open.map((s) => ownArticleFor(ctx, s.row, s.connection, deps).catch(() => null)));
  return open.flatMap((s, i) => {
    const title = signalTitle(s.row);
    const details = signalLines(s.row, { site: siteFor(s, open) });
    const action = own[i] ? "Refresh this article" : "Plan an article";
    const item = title ? agentActionReviewItem(s.action, { title, detail: details.join(" "), action }) : null;
    return item ? [{ ...item, details, signal: { id: s.row.id } }] : [];
  });
}

export type DecideError = "not_found" | "changed" | "no_programme";
export type DecideResult<T> = { ok: true; value: T } | { ok: false; error: DecideError };

/** The open suggestion a row names, or why not: a row of this brand, not blanked, its action still proposed. */
async function openFor(ctx: TenantContext, signalId: string, deps: SuggestionDeps): Promise<{ ok: true; row: DataSignal; action: AgentAction } | { ok: false; error: DecideError }> {
  if (!isDataSignalId(signalId)) return { ok: false, error: "not_found" };
  const row = await getSignal(ctx, signalId, deps);
  if (!row || !row.agentActionId || !isAgentActionId(row.agentActionId)) return { ok: false, error: "not_found" };
  const action = await getAgentAction(ctx, row.agentActionId, deps);
  if (!action || action.action !== DATA_SIGNAL_ACTION || action.agent !== SIGNALS_AGENT || action.target.id !== row.id) return { ok: false, error: "not_found" };
  if (action.state !== "proposed" || !row.label) return { ok: false, error: "changed" };
  return { ok: true, row, action };
}

/** The programme an article is planned in: the one asked for, the autopilot's, or the only one. */
async function programmeFor(ctx: TenantContext, wanted: string | null, deps: SuggestionDeps, loadTenant: (id: string) => Promise<Tenant | null>): Promise<string | null> {
  const active = (await forTenant(ctx, deps.db).workspaces.find({ limit: 200 })).filter((w) => !w.archivedAt);
  if (wanted) return active.some((w) => w.id === wanted) ? wanted : null;
  const auto = (await loadTenant(ctx.tenantId).catch(() => null))?.autopilot?.workspaceId ?? null;
  if (auto && active.some((w) => w.id === auto)) return auto;
  return active.length === 1 ? active[0]!.id : null;
}

/**
 * The link kept on the acted action: the same Create step with no outside text in it (the map
 * question's own link holds only ids).
 */
export function keptHref(workspaceId: string, row: Pick<DataSignal, "rule" | "questionId">): string {
  if (row.rule === "within_reach" && row.questionId) return writeNextHref(workspaceId, row.questionId);
  return `/admin/workspace/${encodeURIComponent(workspaceId)}/create?numbers=${row.rule === "losing_page" ? "page" : "search"}`;
}

/** The Create step for a suggestion: its map question, its page or its search, filled in. */
export function planHref(workspaceId: string, row: Pick<DataSignal, "rule" | "label" | "questionId" | "key">): string {
  if (row.rule === "within_reach" && row.questionId) return writeNextHref(workspaceId, row.questionId);
  const base = `/admin/workspace/${encodeURIComponent(workspaceId)}/create`;
  const text = encodeURIComponent(row.label ?? "");
  if (row.rule === "losing_page") {
    const host = row.key?.host;
    return `${base}?numbers=page&text=${text}${host ? `&hub=${encodeURIComponent(`https://${host}${row.label ?? ""}`)}` : ""}`;
  }
  return `${base}?numbers=search&text=${text}`;
}

const memberOf = (ctx: TenantContext) => ({ type: "member" as const, id: ctx.userId && !ctx.userId.includes("@") ? ctx.userId : "admin" });

/**
 * Plan an article from a suggestion: proposed to acted with its Create link as the result, its
 * values cleared, the row blanked and kept away 30 days. With several programmes and none chosen
 * (or none at all), answers no_programme.
 */
export async function planFromSignal(
  ctx: TenantContext,
  signalId: string,
  input: { workspaceId?: string | null },
  deps: SuggestionDeps & { loadTenant?: (id: string) => Promise<Tenant | null> } = {},
): Promise<DecideResult<{ href: string }>> {
  const open = await openFor(ctx, signalId, deps);
  if (!open.ok) return open;
  // A page that is one of the brand's live articles is refreshed, not planned again.
  const connection = (await planningConnections(ctx, deps).catch(() => new Map<string, DataConnection>())).get(open.row.connectionId);
  const own = connection ? await ownArticleFor(ctx, open.row, connection, deps).catch(() => null) : null;
  const workspaceId = own ? own.workspaceId : await programmeFor(ctx, input.workspaceId ?? null, deps, deps.loadTenant ?? getTenantById);
  if (!workspaceId) return { ok: false, error: "no_programme" };
  const href = own ? refreshHref(own) : planHref(workspaceId, open.row);
  const now = deps.now ?? new Date();
  const kept = own ? refreshHref(own) : keptHref(workspaceId, open.row);
  const r = await transitionAgentAction(ctx, open.action.id, { to: "acted", by: memberOf(ctx), at: now.toISOString(), expectRev: open.action.rev, result: { href: kept }, clearDetails: true }, { db: deps.db });
  if (!r.ok) return { ok: false, error: r.error === "not_found" ? "not_found" : "changed" };
  await blankSignal(ctx, open.row.id, { db: deps.db, now, quietDays: QUIET_DAYS });
  forgetReviewCount(ctx.tenantId);
  return { ok: true, value: { href } };
}

/** Dismiss a suggestion: declined (dismissed), values cleared, the row blanked and kept away 30 days. */
export async function dismissSignal(ctx: TenantContext, signalId: string, deps: SuggestionDeps = {}): Promise<DecideResult<{ dismissedUntil: string }>> {
  const open = await openFor(ctx, signalId, deps);
  if (!open.ok) return open;
  const now = deps.now ?? new Date();
  const r = await transitionAgentAction(ctx, open.action.id, { to: "declined", reason: "dismissed", by: memberOf(ctx), at: now.toISOString(), expectRev: open.action.rev, clearDetails: true }, { db: deps.db });
  if (!r.ok) return { ok: false, error: r.error === "not_found" ? "not_found" : "changed" };
  await blankSignal(ctx, open.row.id, { db: deps.db, now, quietDays: QUIET_DAYS });
  forgetReviewCount(ctx.tenantId);
  return { ok: true, value: { dismissedUntil: new Date(now.getTime() + QUIET_DAYS * 86_400_000).toISOString() } };
}
