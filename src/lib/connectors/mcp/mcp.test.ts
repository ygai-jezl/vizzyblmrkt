import { describe, expect, it } from "vitest";
import { EMPTY_CURSOR } from "../collect/schedule";
import { checkLiveRequest, readLive } from "../live";
import { collectedStream, parseManifest } from "../manifest";
import { fakeMcpServer, MCP_TEST_URL as URL_, testMcpManifest, toolCalls } from "../testing/mcpServer";
import { answerMessages, eventStreamMessages, MCP_PROTOCOL_VERSIONS, openMcpSession, responseTo } from "./client";
import { mcpCollect, mcpLive, mcpVerify, noRowsNote, asTheyStandNote } from "./hooks";
import { callArgs, jsonIn, keyText, streamRows, valueAt } from "./result";

/**
 * The one MCP engine (ADR-0019) against a made-up MCP server: nothing reaches the network, the
 * manifest below is invented, and so is every number.
 */

const manifest = parseManifest(testMcpManifest);
const KEY = "made_up_key_0000000000";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const connection = { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health };
const input = (account = "acme.example") => ({ manifest, connection, account, token: KEY });
const depsOf = (transport: ReturnType<typeof fakeMcpServer>["transport"]) => ({ transport, limit: async () => false, log: () => {}, now: NOW });

const TOOLS = {
  who_am_i: () => ({ site: "Acme.Example", name: "Acme" }),
  history: (args: Record<string, unknown>) => ({
    data: [
      { date: "2026-11-20", count: 12 },
      { date: "2026-11-18", count: 7 },
      { date: "2026-11-19", count: 9 },
    ].filter((r) => r.date >= String(args.startDate) && r.date <= String(args.endDate)),
    pagination: { hasMore: false },
  }),
  cited: () => ({ data: [{ url: "https://acme.example/pricing?ref=x", engines: ["chatgpt", "claude"], count: 4 }] }),
  prompts: () => ({ data: [{ text: "best made up tools", metrics: { total: 3 } }], pagination: { hasMore: true } }),
};

describe("the MCP client", () => {
  it("initializes, sends initialized, then calls the tool, with the key only in Authorization", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(server.transport));
    expect(r.ok).toBe(true);
    expect(server.requests.map((q) => q.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const init = server.requests[0]!;
    expect(init.params).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "YouGrow" } });
    for (const q of server.requests) {
      expect(q.url).toBe(URL_);
      expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(q.headers.accept).toBe("application/json, text/event-stream");
    }
    // After initialize, every request names the protocol version agreed.
    expect(server.requests[1]!.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSIONS[0]);
    expect(server.requests[2]!.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it("reads an event stream answer, skipping what comes before it, and ends a stream left open", async () => {
    for (const keepOpen of [false, true]) {
      const server = fakeMcpServer({ tools: TOOLS, sse: true, keepOpen });
      const r = await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(server.transport));
      expect(r).toMatchObject({ ok: true, rows: [{ day: "2026-11-18", cfRequests: 7 }, { day: "2026-11-19", cfRequests: 9 }, { day: "2026-11-20", cfRequests: 12 }] });
    }
  });

  it("echoes the session id the server names on every later request, and closes the session", async () => {
    const server = fakeMcpServer({ tools: TOOLS, sessionId: "made-up-session-1" });
    const r = await mcpVerify(input(""), depsOf(server.transport));
    expect(r).toEqual({ ok: true, account: "acme.example", label: "Acme" });
    expect(server.requests[0]!.headers["mcp-session-id"]).toBeUndefined();
    for (const q of server.requests.slice(1)) expect(q.headers["mcp-session-id"]).toBe("made-up-session-1");
    expect(server.requests.at(-1)!.httpMethod).toBe("DELETE");
  });

  it("sends no DELETE when the server names no session", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    await mcpVerify(input(""), depsOf(server.transport));
    expect(server.requests.some((q) => q.httpMethod === "DELETE")).toBe(false);
  });

  it("turns a 401 into a refused key, which marks the connection broken: access lost", async () => {
    const server = fakeMcpServer({ tools: TOOLS, status: 401 });
    expect(await mcpVerify(input(""), depsOf(server.transport))).toMatchObject({ ok: false, code: "token_refused" });
    expect(server.requests).toHaveLength(1);
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, status: 403 }).transport))).toMatchObject({ code: "token_refused" });
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, status: 429 }).transport))).toMatchObject({ code: "rate_limited" });
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, status: 503 }).transport))).toMatchObject({ code: "provider_error" });
    // A lost session or a wrong endpoint is the provider's, never an account the key can't read.
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, status: 404 }).transport))).toMatchObject({ code: "provider_error" });
  });

  it("refuses a host outside the manifest's allowlist before any request", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await openMcpSession({ manifest, connection, token: KEY, url: "https://evil.example/v1/mcp" }, depsOf(server.transport));
    expect(r).toMatchObject({ ok: false, code: "host_not_allowed" });
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a protocol version it doesn't speak, a JSON-RPC error and a tool that says it failed", async () => {
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, protocolVersion: "2023-01-01" }).transport))).toMatchObject({ ok: false, code: "bad_response" });
    const missing = fakeMcpServer({ tools: { ...TOOLS, history: () => ({ isError: true, text: "Error 403 INSUFFICIENT_SCOPE: made up" }) } });
    expect(await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(missing.transport))).toMatchObject({ ok: false, code: "query_refused" });
    const { history: _gone, ...noHistory } = TOOLS;
    const r = await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(fakeMcpServer({ tools: noHistory }).transport));
    expect(r).toMatchObject({ ok: false, code: "query_refused" });
  });

  it("finds the answer among a batch, a stream's events, and nothing that isn't JSON", () => {
    expect(responseTo([[{ jsonrpc: "2.0", id: 2, result: 1 }, { jsonrpc: "2.0", id: 3, result: 2 }]], 3)).toEqual({ result: 2 });
    expect(responseTo([{ jsonrpc: "2.0", id: 3, error: { code: -32602 } }], 3)).toEqual({ error: { code: -32602 } });
    expect(responseTo([{ jsonrpc: "2.0", method: "notifications/progress" }], 3)).toBeNull();
    expect(eventStreamMessages('data: {"a":1}\n\n: comment\n\ndata: not json\n\ndata: {"b":\ndata: 2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(answerMessages("text/html", "<p>hi</p>")).toBeNull();
    expect(answerMessages("application/json; charset=utf-8", '[{"id":1}]')).toEqual([{ id: 1 }]);
  });
});

describe("mcp.verify", () => {
  it("checks every tool the manifest calls is offered, then names the account from the verify tool", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    expect(await mcpVerify(input(""), depsOf(server.transport))).toEqual({ ok: true, account: "acme.example", label: "Acme" });
    expect(server.requests.map((q) => q.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(toolCalls(server.requests)).toEqual([{ name: "who_am_i", args: {} }]);
    const { cited: _gone, ...noCited } = TOOLS;
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: noCited }).transport))).toMatchObject({ ok: false, code: "tool_missing" });
  });

  it("refuses a key that now reads another account, and an answer with no account", async () => {
    expect(await mcpVerify(input("other.example"), depsOf(fakeMcpServer({ tools: TOOLS }).transport))).toMatchObject({ ok: false, code: "account_refused" });
    expect(await mcpVerify(input("acme.example"), depsOf(fakeMcpServer({ tools: TOOLS }).transport))).toMatchObject({ ok: true });
    const blank = fakeMcpServer({ tools: { ...TOOLS, who_am_i: () => ({ name: "Acme" }) } });
    expect(await mcpVerify(input(""), depsOf(blank.transport))).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("reads structured content, and JSON a server wrapped in words", async () => {
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, structured: true }).transport))).toMatchObject({ ok: true, account: "acme.example" });
    expect(await mcpVerify(input(""), depsOf(fakeMcpServer({ tools: TOOLS, wrap: true }).transport))).toMatchObject({ ok: true, account: "acme.example" });
  });
});

describe("mcp.live", () => {
  it("fills the days from the window, ending on the last complete day, and sorts the days", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(server.transport));
    expect(toolCalls(server.requests)).toEqual([{ name: "history", args: { startDate: "2026-11-14", endDate: "2026-11-20", limit: 100 } }]);
    expect(r).toMatchObject({ ok: true, period: { from: "2026-11-14", to: "2026-11-20", timeZone: "UTC", finalThrough: "2026-11-20" }, more: false, notes: [] });
  });

  it("caps explicit days at the last complete day, with a note, and reads nothing for days not finished", async () => {
    const capped = await mcpLive({ ...input(), query: { stream: "daily", from: "2026-11-19", to: "2026-11-21", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(fakeMcpServer({ tools: TOOLS }).transport));
    expect(capped).toMatchObject({ ok: true, notes: ["The last complete day in Acme Answers is 20 Nov, so this read ends there."] });
    const server = fakeMcpServer({ tools: TOOLS });
    const empty = await mcpLive({ ...input(), query: { stream: "daily", from: "2026-11-21", to: "2026-11-21", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(server.transport));
    expect(empty).toMatchObject({ ok: true, rows: [] });
    expect(server.requests).toHaveLength(0);
  });

  it("reads a stream for one page on the account's host, and refuses it without a page", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await mcpLive({ ...input(), query: { stream: "pages", period: "last_28_days", by: "page", limit: 100, page: "/pricing" }, today: "2026-11-21" }, depsOf(server.transport));
    expect(toolCalls(server.requests)).toEqual([{ name: "cited", args: { limit: 50, url: "https://acme.example/pricing" } }]);
    expect(r).toMatchObject({ ok: true, rows: [{ page: "https://acme.example/pricing?ref=x", engines: "chatgpt, claude", cfPageViews: 4 }] });
    expect(await mcpLive({ ...input(), query: { stream: "pages", period: "last_28_days", by: "page", limit: 100 }, today: "2026-11-21" }, depsOf(server.transport))).toMatchObject({ ok: false, code: "query_refused" });
    // The live check says so before any call.
    expect(checkLiveRequest(manifest, { stream: "pages", period: "last_28_days", by: "page" }, NOW)).toEqual({ ok: false, error: "page_needed" });
  });

  it("says numbers from a call that takes no days are as they stand, and passes on that there are more", async () => {
    const r = await mcpLive({ ...input(), query: { stream: "now", period: "last_28_days", by: "topic", limit: 100 }, today: "2026-11-21" }, depsOf(fakeMcpServer({ tools: TOOLS }).transport));
    expect(r).toMatchObject({ ok: true, rows: [{ prompt: "best made up tools", cfVisits: 3 }], more: true, notes: [asTheyStandNote("Acme Answers")] });
  });

  it("gives no rows, with a note, when they aren't where the manifest says", async () => {
    const moved = fakeMcpServer({ tools: { ...TOOLS, history: () => ({ items: [{ date: "2026-11-20", count: 12 }] }) } });
    const r = await mcpLive({ ...input(), query: { stream: "daily", period: "last_7_days", by: "day", limit: 100 }, today: "2026-11-21" }, depsOf(moved.transport));
    expect(r).toMatchObject({ ok: true, rows: [], notes: [noRowsNote("Acme Answers")] });
  });

  it("goes through readLive: page keys cleaned to their paths, every number with its meaning", async () => {
    const r = await readLive({ ...input(), query: { stream: "pages", period: "last_28_days", by: "page", limit: 100, page: "/pricing" } }, depsOf(fakeMcpServer({ tools: TOOLS }).transport));
    expect(r).toMatchObject({ ok: true, answer: { connectorId: "acme-answers", rows: [{ page: "/pricing", engines: "chatgpt, claude", cfPageViews: 4 }] } });
    if (r.ok) expect(Object.keys(r.answer.meanings)).toEqual(["cfPageViews"]);
  });
});

describe("mcp.collect", () => {
  const stream = collectedStream(manifest)!;
  const ask = (cursor = EMPTY_CURSOR) => ({ stream, cursor, now: NOW, canStart: () => true });

  it("fills its days in one call, newest first, each day's numbers as the day's totals", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await mcpCollect({ ...input(), ask: ask() }, depsOf(server.transport));
    // At 10:00 UTC on 21 Nov the newest day due is 20 Nov (a day's lag, from 03:00).
    expect(toolCalls(server.requests)).toEqual([{ name: "history", args: { startDate: "2026-08-23", endDate: "2026-11-20", limit: 90 } }]);
    expect(r.failure).toBeNull();
    expect(r.newest).toBe("2026-11-20");
    expect(r.days).toHaveLength(90);
    const day = (d: string) => r.days.find((x) => x.day === d)!;
    expect(day("2026-11-20")).toEqual({ day: "2026-11-20", final: true, docs: [{ by: "day", totals: { cfRequests: 12 }, rows: [], more: false }] });
    // A day the tool doesn't list is kept with no numbers, never zero: final once it is old enough.
    expect(day("2026-11-17").docs[0]!.totals).toEqual({ cfRequests: null });
    expect(day("2026-11-17").final).toBe(true);
  });

  it("reads a recent day the tool doesn't list yet again later", async () => {
    const late = fakeMcpServer({ tools: { ...TOOLS, history: () => ({ data: [{ date: "2026-11-18", count: 7 }], pagination: { hasMore: false } }) } });
    const r = await mcpCollect({ ...input(), ask: ask({ lastDay: "2026-11-17", finalThrough: "2026-11-17", backfilledTo: "2026-08-20", filled: true, timeZone: "UTC" }) }, depsOf(late.transport));
    expect(r.days.map((d) => [d.day, d.final])).toEqual([
      ["2026-11-18", true],
      ["2026-11-19", false],
      ["2026-11-20", false],
    ]);
  });

  it("keeps nothing when the rows aren't where the manifest says, or the call fails", async () => {
    const moved = fakeMcpServer({ tools: { ...TOOLS, history: () => ({ items: [] }) } });
    expect(await mcpCollect({ ...input(), ask: ask() }, depsOf(moved.transport))).toMatchObject({ days: [], failure: { code: "bad_response" } });
    expect(await mcpCollect({ ...input(), ask: ask() }, depsOf(fakeMcpServer({ tools: TOOLS, status: 401 }).transport))).toMatchObject({ days: [], failure: { code: "token_refused" } });
  });
});

describe("reading a result as data", () => {
  it("follows a path, writes keys as text and numbers only as numbers", () => {
    expect(valueAt({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(valueAt({ a: [1] }, "a.length")).toBeUndefined();
    expect(valueAt([1], "$")).toEqual([1]);
    expect(keyText(["chatgpt", "claude"])).toBe("chatgpt, claude");
    expect(keyText("two\nlines")).toBe("two lines");
    expect(keyText({})).toBeNull();
    expect(streamRows({ data: [{ n: "4", m: 4 }] }, { rows: "data", keys: {}, measures: { a: "n", b: "m" } })).toEqual({ rows: [{ a: null, b: 4 }], more: false });
    expect(streamRows({ data: {} }, { rows: "data", keys: {}, measures: {} })).toBeNull();
    expect(jsonIn('Some words.\n{"a":1}\nMore words.')).toEqual({ a: 1 });
    expect(callArgs({ args: { x: 1 }, fill: { y: "page" } }, {})).toBeNull();
    expect(callArgs({ args: { x: 1 }, fill: { y: "from" } }, { from: "2026-11-01" })).toEqual({ x: 1, y: "2026-11-01" });
  });
});
