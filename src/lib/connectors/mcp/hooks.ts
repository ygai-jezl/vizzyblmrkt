import { newestDue, nextAt, planDays } from "../collect/schedule";
import type { CollectHook, CollectResult, HookFailure, LiveHook, LiveRow, VerifyHook } from "../handlers/types";
import { LIVE_LIMITS, mcpMethod, streamOf, type ConnectorManifest, type McpStream, type ProducedStream } from "../manifest";
import type { ConnectorErrorCode } from "../messages";
import { addDays, cappedNote, daysIn, nothingYetNote, resolveWindow } from "../period";
import { withMcpSession, type McpTarget } from "./client";
import { callArgs, keyText, needsPage, pageUrlOf, resultData, streamRows, valueAt, type FillValues, type RowRules } from "./result";

/**
 * The one MCP engine's hooks (ADR-0019), named by every MCP connector's manifest (MCP_HOOKS): no
 * code per connector. Each opens a session with the connection's key, calls the tools its manifest
 * names, reads the rows where the manifest says they are, and closes the session.
 *
 * - mcp.verify lists the server's tools (every tool the manifest calls must be there), calls the
 *   verify tool and reads the account the key belongs to from its result. On a saved connection
 *   the key must still read that same account.
 * - mcp.live reads one stream: the window worked out as the other connectors do (a named period
 *   ends on the stream's last complete day, its lag after today in its zone; explicit days are
 *   capped there with a note), the arguments filled from it, and the rows mapped to the stream's
 *   keys and numbers. Rows a manifest can't find give none, with a note, never zeros. A stream whose
 *   call takes no days says its numbers are as they stand now.
 * - mcp.collect keeps one row a day of a stream collected by day: the days due, newest first while
 *   it fills, read in one call, each day's numbers as the day's totals. A day the tool doesn't list
 *   is kept with no numbers (not measured), never as zeros. A day is final only once it is
 *   MCP_SETTLE_DAYS older than the newest day due, listed or not, so a day the provider was still
 *   working out is read again on later runs and the cursor still moves past one it never measured.
 *   A tool that says it has more rows than it sent covers only the days it listed; the others wait
 *   for the next run.
 * - Rows follow their keys' places: a key that joins on page keeps only the brand's own pages (an
 *   address on another site is left empty, so it never joins the brand's page of the same path),
 *   and a key that joins on day is written as the day in the stream's zone, a timestamp included.
 */

/** Collecting: a day D is read from 03:00 in the stream's zone once its lag has passed. */
export const MCP_COLLECT_HOUR = 3;
/** A day within this many days of the newest due may still change, so it is read again until it is older. */
export const MCP_SETTLE_DAYS = 2;

const failed = (code: ConnectorErrorCode): HookFailure => ({ ok: false, code, retryAfterSec: null });

/** The note when rows aren't where the manifest says. */
export const noRowsNote = (provider: string) => `${provider} answered in a shape this connector doesn't read, so this answer has no rows.`;
/** The note for a stream whose call takes no days. */
export const asTheyStandNote = (provider: string) => `${provider} gives these numbers as they stand now, not for the days asked.`;

/** Where a connection's calls go: its manifest's server, with its key. */
function targetOf(input: { manifest: ConnectorManifest; connection: McpTarget["connection"]; token: string }): McpTarget | null {
  const method = mcpMethod(input.manifest);
  return method ? { manifest: input.manifest, connection: input.connection, token: input.token, url: method.url } : null;
}

/** An account as a connection stores it: one line, lower case. */
const accountOf = (v: unknown) => keyText(v)?.toLowerCase().slice(0, 200) ?? null;

export const mcpVerify: VerifyHook = async (input, deps) => {
  const method = mcpMethod(input.manifest);
  const target = targetOf(input);
  if (!method || !target) return failed("query_refused");
  return withMcpSession(target, deps, async (session) => {
    const listed = await session.listTools();
    if (!listed.ok) return listed;
    const wanted = [method.verify.tool, ...input.manifest.produces.flatMap((p) => (p.mcp ? [p.mcp.tool] : []))];
    if (wanted.some((t) => !listed.tools.includes(t))) return failed("tool_missing");
    const r = await session.callTool(method.verify.tool, method.verify.args ?? {});
    if (!r.ok) return r;
    const data = resultData(r.result);
    const account = accountOf(valueAt(data, method.verify.account));
    if (!account) return failed("bad_response");
    // Check now on a saved connection: the key must still read the account it was connected for.
    if (input.account && input.account !== account) return failed("account_refused");
    const label = method.verify.label ? keyText(valueAt(data, method.verify.label)) : null;
    return { ok: true as const, account, ...(label ? { label: label.slice(0, 60) } : {}) };
  });
};

/** The stream's key that joins on day, when it has one. */
const dayKeyOf = (stream: ProducedStream) => Object.entries(stream.joins).find(([, shared]) => shared === "day")?.[0] ?? null;

/** What the stream's joins say about its keys' values, for this connection's account. */
function rulesOf(stream: ProducedStream, account: string): RowRules {
  const joined = (key: string) => new Set(Object.entries(stream.joins).filter(([, shared]) => shared === key).map(([k]) => k));
  return { pageKeys: joined("page"), dayKeys: joined("day"), account, timeZone: stream.timeZone ?? "UTC" };
}

/** The fills a read offers: its days, its rows, the account and the page. */
function fillsFor(account: string, from: string, to: string, limit: number, page: string | undefined): FillValues {
  const pageUrl = pageUrlOf(account, page);
  return { from, to, limit: Math.min(limit, LIVE_LIMITS.maxRows), account, ...(page ? { page } : {}), ...(pageUrl ? { pageUrl } : {}) };
}

/** Takes the days of a call: whether a stream's numbers are for the days read or as they stand. */
const takesDays = (block: McpStream) => Object.values(block.fill ?? {}).some((f) => f === "from" || f === "to");

export const mcpLive: LiveHook = async (input, deps) => {
  const { query, manifest } = input;
  const stream = streamOf(manifest, query.stream);
  const block = stream?.mcp;
  const target = targetOf(input);
  if (!stream || !block || !target || !stream.liveBy.includes(query.by)) return failed("query_refused");
  if (needsPage(block) && !query.page) return failed("query_refused");
  const lastComplete = addDays(input.today, -Math.max(1, stream.lagDays));
  const window = resolveWindow(query, lastComplete);
  const period = { from: window.from, to: window.to, timeZone: stream.timeZone ?? "UTC", finalThrough: window.empty ? null : window.to };
  const dated = takesDays(block);
  if (window.empty && dated) return { ok: true, rows: [], notes: [nothingYetNote(manifest.name, window.from, window.to, lastComplete)], period, more: false };
  const args = callArgs(block, fillsFor(input.account, window.from, window.to, query.limit, query.page));
  if (!args) return failed("query_refused");

  const r = await withMcpSession(target, deps, (session) => session.callTool(block.tool, args));
  if (!r.ok) return r;
  const mapped = streamRows(resultData(r.result), block, rulesOf(stream, input.account));
  const notes: string[] = [];
  if (dated && window.capped) notes.push(cappedNote(manifest.name, lastComplete));
  if (!dated) notes.push(asTheyStandNote(manifest.name));
  if (!mapped) return { ok: true, rows: [], notes: [...notes, noRowsNote(manifest.name)], period, more: false };
  const dayKey = dayKeyOf(stream);
  // Days oldest first, and only the days read; anything else in the tool's own order.
  const rows: LiveRow[] =
    query.by === "day" && dayKey
      ? mapped.rows.filter((row) => typeof row[dayKey] === "string" && row[dayKey]! >= window.from && row[dayKey]! <= window.to).sort((a, b) => String(a[dayKey]).localeCompare(String(b[dayKey])))
      : mapped.rows;
  return { ok: true, rows, notes, period, more: mapped.more };
};

export const mcpCollect: CollectHook = async (input, deps) => {
  const { ask } = input;
  const stream = ask.stream;
  const block = stream.mcp;
  const zone = stream.timeZone ?? "UTC";
  const keepDays = stream.collect.keepDays;
  const newest = newestDue(ask.now, zone, Math.max(1, stream.lagDays), MCP_COLLECT_HOUR);
  const base: CollectResult = { days: [], newest, moreDue: false, nextDueMs: nextAt(ask.now, zone, MCP_COLLECT_HOUR, 0).getTime(), reachFrom: null, timeZone: zone, probed: false, hold: null, failure: null };
  const target = targetOf(input);
  const dayKey = dayKeyOf(stream);
  if (!block || !target || !dayKey) return { ...base, failure: failed("query_refused") };
  if (!ask.canStart()) return { ...base, moreDue: true };
  // Days kept before they were final (not listed yet) are read again, oldest first, ahead of new ones.
  const plan = planDays(ask.cursor, newest, { keepDays, maxDays: Math.min(keepDays, LIVE_LIMITS.maxRows), rereadThrough: newest });
  if (!plan.length) return base;
  const sorted = plan.map((p) => p.day).sort();
  const from = sorted[0]!;
  const to = sorted.at(-1)!;
  const args = callArgs(block, fillsFor(input.account, from, to, daysIn(from, to), undefined));
  if (!args) return { ...base, failure: failed("query_refused") };

  const r = await withMcpSession(target, deps, (session) => session.callTool(block.tool, args));
  if (!r.ok) return { ...base, failure: r };
  const mapped = streamRows(resultData(r.result), block, rulesOf(stream, input.account));
  // Rows that aren't where the manifest says are never kept as days with no numbers.
  if (!mapped) return { ...base, failure: failed("bad_response") };
  const byDay = new Map(mapped.rows.filter((row) => typeof row[dayKey] === "string").map((row) => [String(row[dayKey]), row] as const));
  // A tool that has more rows than it sent covers only the days it listed: the rest are read on the
  // next run, never kept as days with no numbers.
  const listed = [...byDay.keys()].sort();
  if (mapped.more && !listed.length) return { ...base, failure: failed("bad_response") };
  const covers = (day: string) => !mapped.more || (day >= listed[0]! && day <= listed.at(-1)!);
  const out: CollectResult = { ...base };
  const settled = addDays(newest, -MCP_SETTLE_DAYS);
  for (const day of sorted) {
    if (!covers(day)) {
      out.moreDue = true;
      continue;
    }
    const row = byDay.get(day);
    const totals: Record<string, number | null> = {};
    for (const m of stream.measures) totals[m] = row && typeof row[m] === "number" ? (row[m] as number) : null;
    out.days.push({ day, final: day <= settled, docs: [{ by: "day", totals, rows: [], more: false }] });
  }
  return out;
};
