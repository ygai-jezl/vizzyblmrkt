import { forTenant, type TenantContext } from "@/lib/tenant";
import { meaningsOf, type Meaning, type MeaningKey } from "@/lib/metrics/meanings";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { RolledSpan } from "@/lib/types/metricSnapshot";
import { isConnectorsCollectEnabled } from "./flags";
import { feedsPlanning, type ConnectorJob } from "./grants";
import { rolledId } from "./keys";
import type { LiveAnswer } from "./live";
import { LIVE_BY_JOINS, LIVE_LIMITS, type ConnectorManifest, type ConnectorUse, type LiveBy, type ProducedStream } from "./manifest";
import { needsPage } from "./mcp/result";
import type { LivePeriod } from "./period";
import { getConnector } from "./registry";
import { readLiveFor, type ServiceDeps, type ServiceResult } from "./service";
import { readSnapshot } from "./snapshots";
import { readableOnly } from "./sources";

/**
 * Features read kinds of data, never vendors (ADR-0019). `readByUse(ctx, use, ask)` finds the
 * brand's connections whose manifest declares that use (a USES value, such as signals.ai_answers)
 * and that feed planning (members and Vizzy may both read them, grants.ts feedsPlanning), picks in
 * each the stream that gives every number asked for, by meaning, grouped as asked, and returns its
 * rows with their keys named by the shared key each joins on (day, page, topic) and their numbers
 * by meaning. A feature never names a connector, a stream or a provider's field.
 *
 * - The brand comes only from ctx; connections are read through forTenant, so another brand's are
 *   never seen. A brand's part of its organisation's connection counts only while it is given
 *   (partLive, through readableOnly).
 * - Collected numbers are read where the stream keeps them for the period (the rolled 28 and 90
 *   day docs, while CONNECTORS_COLLECT_ENABLED is on); everything else is read live, as one of the
 *   brand's scheduled jobs, which may read only a connection that feeds planning.
 * - Connections are read at once, in parallel. A read that fails leaves that connection out, with
 *   its code, and never stops the others.
 *
 * Search Console's planning lines (src/lib/connectors/signals/planning.ts) still read its manifest
 * directly; they move onto this reader next.
 */

export interface UseAsk {
  /** The numbers wanted, by meaning: only a stream that gives every one of them is read. */
  measures: readonly MeaningKey[];
  /** How the rows are grouped. */
  by: LiveBy;
  period: LivePeriod;
  /** Rows wanted from each connection, at most LIVE_LIMITS.maxRows. */
  limit?: number;
}

export interface UseRow {
  /** The row's keys, each by the shared key it joins on (day, page, topic), else by its own name. */
  keys: Record<string, string | null>;
  /** Its numbers, by meaning. */
  m: Partial<Record<MeaningKey, number | null>>;
}

export interface UseRead {
  connectionId: string;
  /** The tool's name and id, for a source line under what a feature shows. Features never branch on them. */
  connectorId: string;
  connector: string;
  stream: string;
  /** collected: from the numbers kept each day; live: read from the tool just now. */
  from: "collected" | "live";
  period: { from: string; to: string; timeZone: string | null } | null;
  rows: UseRow[];
  /** The tool has rows this read leaves out. */
  more: boolean;
  notes: string[];
  /** The meaning of every number in rows. */
  meanings: Partial<Record<MeaningKey, Meaning>>;
}

export interface UseResult {
  reads: UseRead[];
  /** Connections that feed planning with this use whose read failed this time, with the code. */
  failed: Array<{ connectionId: string; code: string }>;
}

export interface UseDeps extends ServiceDeps {
  /** The scheduled job reading, for its activity rows (job:<name>). */
  job: ConnectorJob;
  /** The manifest for a connector id: the registry's offered connectors (tests pass their own). */
  manifestOf?: (connectorId: string) => ConnectorManifest | null;
  /** The live read: readLiveFor (tests pass their own). */
  live?: (ctx: TenantContext, actor: { kind: "job"; job: ConnectorJob }, id: string, query: unknown, deps: ServiceDeps) => Promise<ServiceResult<LiveAnswer>>;
}

/** The most connections a brand's read looks at. */
const MAX_CONNECTIONS = 50;
const ROLLED: Partial<Record<LivePeriod, RolledSpan>> = { last_28_days: "r28", last_90_days: "r90" };

/** The stream of a manifest that gives every number asked for, grouped as asked, and is read for the whole account. */
export function streamForUse(m: Pick<ConnectorManifest, "produces">, ask: Pick<UseAsk, "measures" | "by">): ProducedStream | null {
  return m.produces.find((p) => !p.personal && p.liveBy.includes(ask.by) && ask.measures.every((k) => p.measures.includes(k)) && !needsPage(p.mcp)) ?? null;
}

/** A key's name in a feature's eyes: the shared key it joins on, else its own. */
const keyName = (stream: ProducedStream, key: string) => stream.joins[key] ?? key;

/** Only the numbers the stream lists, by meaning. */
function numbersOf(stream: ProducedStream, from: Record<string, unknown>): UseRow["m"] {
  const m: UseRow["m"] = {};
  for (const k of stream.measures) {
    const v = from[k];
    m[k as MeaningKey] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return m;
}

/** The kept rolled doc for the period, as rows, or null when the stream doesn't keep it. */
async function collectedRows(ctx: TenantContext, conn: DataConnection, stream: ProducedStream, ask: UseAsk, deps: UseDeps): Promise<Omit<UseRead, "connectionId" | "connectorId" | "connector" | "stream" | "meanings"> | null> {
  const span = ROLLED[ask.period];
  if (!span || !stream.collect || !stream.collect.by.includes(ask.by) || !conn.collect || !isConnectorsCollectEnabled()) return null;
  const doc = await readSnapshot(ctx, rolledId(conn.id, conn.collect.gen, stream.stream, ask.by, span), deps);
  if (!doc || !doc.window) return null;
  const joined = LIVE_BY_JOINS[ask.by];
  const limit = Math.min(ask.limit ?? LIVE_LIMITS.maxRows, LIVE_LIMITS.maxRows);
  const rows = doc.rows.map((r) => ({ keys: { [joined]: r.key, ...(r.host ? { host: r.host } : {}) }, m: numbersOf(stream, r.m) }));
  // By day the latest days are kept, as a live read keeps them.
  const kept = rows.length > limit ? (ask.by === "day" ? rows.slice(-limit) : rows.slice(0, limit)) : rows;
  return { from: "collected", period: { ...doc.window, timeZone: doc.timeZone }, rows: kept, more: doc.more || rows.length > limit || doc.rowsDropped > 0, notes: [] };
}

/** The brand's rows of one kind of data, from every connection that declares it and feeds planning. */
export async function readByUse(ctx: TenantContext, use: ConnectorUse, ask: UseAsk, deps: UseDeps): Promise<UseResult> {
  const manifestOf = deps.manifestOf ?? getConnector;
  const all = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: MAX_CONNECTIONS });
  const declared = all.filter((c) => c.account && feedsPlanning(c.grants) && (manifestOf(c.connectorId)?.uses ?? []).includes(use));
  const conns = await readableOnly(ctx, declared, deps);
  const live = deps.live ?? readLiveFor;
  /** One connection's read: its rows, its failure, or nothing when no stream gives what is asked. */
  const readOne = async (conn: DataConnection): Promise<{ read: UseRead } | { failed: { connectionId: string; code: string } } | null> => {
    const m = manifestOf(conn.connectorId)!;
    const stream = streamForUse(m, ask);
    if (!stream) return null;
    const base = { connectionId: conn.id, connectorId: m.id, connector: m.name, stream: stream.stream, meanings: meaningsOf(stream.measures.filter((k) => ask.measures.includes(k as MeaningKey))) };
    const kept = await collectedRows(ctx, conn, stream, ask, deps).catch(() => null);
    if (kept) return { read: { ...base, ...kept } };
    const r = await live(ctx, { kind: "job", job: deps.job }, conn.id, { stream: stream.stream, period: ask.period, by: ask.by, limit: Math.min(ask.limit ?? LIVE_LIMITS.maxRows, LIVE_LIMITS.maxRows) }, deps).catch(
      (): ServiceResult<LiveAnswer> => ({ ok: false, status: 502, error: "network" }),
    );
    if (!r.ok) return { failed: { connectionId: conn.id, code: r.error } };
    const a = r.value;
    const rows = a.rows.map((row) => {
      const keys: UseRow["keys"] = {};
      for (const k of stream.keys) keys[keyName(stream, k)] = typeof row[k] === "string" ? (row[k] as string) : null;
      return { keys, m: numbersOf(stream, row) };
    });
    return { read: { ...base, from: "live", period: { from: a.period.from, to: a.period.to, timeZone: a.period.timeZone }, rows, more: a.more, notes: a.notes } };
  };
  // Every connection at once: each read is its own provider's, and one slow one never holds up the rest.
  const settled = await Promise.allSettled(conns.map(readOne));
  const out: UseResult = { reads: [], failed: [] };
  settled.forEach((s, i) => {
    if (s.status === "rejected") out.failed.push({ connectionId: conns[i]!.id, code: "failed" });
    else if (s.value && "read" in s.value) out.reads.push(s.value.read);
    else if (s.value) out.failed.push(s.value.failed);
  });
  return out;
}
