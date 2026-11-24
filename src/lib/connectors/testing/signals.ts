import { createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { freshCollect, type ConnectionGrant } from "@/lib/types/dataConnection";
import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { healthyAt } from "../health";
import { planningId } from "../keys";
import { addDays } from "../period";
import { putSnapshot, ttlFor, writeDayDoc } from "../snapshots";

/**
 * Fixtures for suggestions from collected numbers (Connectors 2 group 4): a Search Console
 * connection with 90 collected days to 20 Nov, and its day docs and planning docs, all made up for
 * made-up sites (fernhill.example). No provider is ever called.
 */

export const LAST_DAY = "2026-11-20";
export const SC_STREAM = "search_performance";
export const PLANNING: ConnectionGrant[] = [
  { to: "members", can: "read" },
  { to: "agent:vizzy", can: "read" },
];

/** A connected Search Console site, collected to 20 Nov with 90 days kept. */
export async function seedSearchConsole(ctx: TenantContext, db: FirestoreLike, id: string, over: Partial<NewDataConnection> = {}): Promise<void> {
  const at = "2026-08-20T10:00:00.000Z";
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: "search-console",
      method: "share_access",
      label: "Google Search Console",
      account: "sc-domain:fernhill.example",
      ownerUid: "usr_admin",
      grants: PLANNING,
      secrets: {},
      health: healthyAt(new Date(at)),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: null,
      collect: { ...freshCollect(null, 0), lastDay: LAST_DAY, finalThrough: LAST_DAY, backfilledTo: addDays(LAST_DAY, -89), filled: true, timeZone: "America/Los_Angeles", rolledOn: "2026-11-23" },
      ...over,
    },
    [{ kind: "connected", by: "usr_admin", at }],
    db,
  );
}

const owner = (id: string, account = "sc-domain:fernhill.example", gen = 0) => ({ id, connectorId: "search-console", account, gen });

/**
 * Day docs for one grouping, `days` of them to the last day, each day's rows from `rowsOn`. A day
 * listed in `cut` keeps its rows but says some were cut, with `floor` as its last kept row.
 */
export async function writeDays(
  ctx: TenantContext,
  db: FirestoreLike,
  id: string,
  by: "page" | "topic",
  days: number,
  rowsOn: (day: string, i: number) => SnapshotRow[],
  opts: { cut?: Set<string>; floor?: Record<string, number>; last?: string; gen?: number } = {},
): Promise<string[]> {
  const last = opts.last ?? LAST_DAY;
  const list = Array.from({ length: days }, (_, i) => addDays(last, i - days + 1));
  for (const [i, day] of list.entries()) {
    const rows = rowsOn(day, i);
    const cut = opts.cut?.has(day) ?? false;
    // A cut day: one more row than kept, below the floor, so the store records the cut and floor.
    const extra: SnapshotRow[] = cut ? Array.from({ length: 500 }, (_, k) => ({ key: `/filler-${k}`, host: "fernhill.example", m: { searchClicks: opts.floor?.searchClicks ?? 1, searchImpressions: opts.floor?.searchImpressions ?? 1 } })) : [];
    await writeDayDoc(ctx, { owner: owner(id, undefined, opts.gen), stream: SC_STREAM, by, day, timeZone: "America/Los_Angeles", final: true, totals: null, rows: [...rows, ...extra], more: false, keepDays: 90 }, { db, now: new Date("2026-11-23T09:00:00.000Z") });
  }
  return list;
}

/** A search row for a topic day doc. */
export const search = (words: string, impressions: number, clicks = 0, position = 9): SnapshotRow => ({ key: words, m: { searchImpressions: impressions, searchClicks: clicks, searchPosition: position } });
/** A page row for a page day doc. */
export const page = (path: string, clicks: number, impressions = clicks * 20, host = "fernhill.example"): SnapshotRow => ({ key: path, host, m: { searchClicks: clicks, searchImpressions: impressions } });

/** A planning doc (questions or subjects) over the 28 days to the last day. */
export async function writePlanning(ctx: TenantContext, db: FirestoreLike, id: string, by: "question" | "subject", rows: SnapshotRow[], opts: { last?: string; gen?: number; account?: string } = {}): Promise<void> {
  const last = opts.last ?? LAST_DAY;
  const gen = opts.gen ?? 0;
  await putSnapshot(
    ctx,
    planningId(id, gen, SC_STREAM, by),
    {
      connectionId: id,
      gen,
      account: opts.account ?? "sc-domain:fernhill.example",
      connectorId: "search-console",
      stream: SC_STREAM,
      by,
      day: null,
      window: { from: addDays(last, -27), to: last },
      days: 28,
      timeZone: "America/Los_Angeles",
      final: true,
      totals: null,
      rows,
      rowsSeen: rows.length,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: "2026-11-23T09:00:00.000Z",
      ttlAt: ttlFor(last, 90),
    },
    { db },
  );
}

/** Open suggestions, as detection leaves them: a row and its Review suggestion (made-up numbers). */
export const SUGGESTIONS = {
  losing: {
    rule: "losing_page" as const,
    key: { page: "/care/fiddle-leaf-fig", host: "fernhill.example" },
    label: "/care/fiddle-leaf-fig",
    numbers: { searchClicks: 41 },
    before: { searchClicks: 96 },
    window: { from: "2026-10-24", to: LAST_DAY, beforeFrom: "2026-09-26", beforeTo: "2026-10-23" },
  },
  reach: {
    rule: "within_reach" as const,
    key: { topic: "how often to water monstera" },
    label: "how often to water monstera",
    questionId: "q_monstera000000000",
    question: "How often should I water a monstera?",
    numbers: { searchPosition: 8.6, searchImpressions: 1900, searchClicks: 40 },
    window: { from: "2026-10-24", to: LAST_DAY },
  },
  rising: {
    rule: "rising_search" as const,
    key: { topic: "pet safe hanging plants" },
    label: "pet safe hanging plants",
    numbers: { searchImpressions: 260, searchClicks: 9 },
    before: { searchImpressions: 40 },
    window: { from: "2026-11-07", to: LAST_DAY, beforeFrom: "2026-10-24", beforeTo: "2026-11-06" },
  },
};

/** Save a row and propose its Review suggestion, as the detector does. */
export async function seedSuggestion(
  ctx: TenantContext,
  db: FirestoreLike,
  connectionId: string,
  which: keyof typeof SUGGESTIONS,
  opts: { now?: Date; account?: string; gen?: number } = {},
): Promise<{ signalId: string; actionId: string }> {
  const { saveDetection, linkAction } = await import("../signals/store");
  const { proposeAgentAction } = await import("@/lib/tenant");
  const { agentDedupeKey } = await import("@/lib/types/agentAction");
  const now = opts.now ?? new Date("2026-11-23T10:00:00.000Z");
  const s = SUGGESTIONS[which];
  const gen = opts.gen ?? 0;
  const { row } = await saveDetection(ctx, { connectionId, gen, account: opts.account ?? "sc-domain:fernhill.example", connectorId: "search-console", shownIn: "review", ...s }, { db, now });
  const { action } = await proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey("data_signal.suggest", row.id, "r1"),
      agent: "connector_signals",
      action: "data_signal.suggest",
      target: { type: "data_signal", id: row.id },
      personId: null,
      proposal: { rule: s.rule, connectionId, gen, label: s.label, numbers: s.numbers },
      basis: null,
      signals: [{ kind: "data_signal", ref: row.id }],
      review: { kind: "data_signal", href: "/admin/approvals#data_signal" },
      requestedBy: { type: "system", id: "connector_signals" },
      expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      clearDetailsOnClose: true,
      at: now.toISOString(),
    },
    { db },
  );
  await linkAction(ctx, row.id, action.id, 1, { db });
  return { signalId: row.id, actionId: action.id };
}
