import type { HookFailure } from "../handlers/types";
import type { ConnectorErrorCode } from "../messages";
import { connectorFetch, type ConnectorCall, type ConnectorFetchDeps } from "../safeFetch";

/**
 * A small client for a remote MCP server over Streamable HTTP (ADR-0019), written here so no
 * dependency is added: JSON-RPC 2.0 over POST, as the MCP specification describes it
 * (modelcontextprotocol.io/specification, Transports and Lifecycle).
 *
 * - A session starts with `initialize` (the client's protocol version, no capabilities, its name),
 *   then the `notifications/initialized` notification; then `tools/list` and `tools/call`.
 * - Every request accepts `application/json` and `text/event-stream`: the server may answer with
 *   one JSON message (or a batch) or an event stream whose `data:` lines carry messages. The answer
 *   is the message with this request's id; anything else on the stream (progress, logging, a
 *   request to the client) is left alone, as YouGrow offers the server no capabilities.
 * - A server that names a session in `Mcp-Session-Id` gets it back on every later request, with
 *   `MCP-Protocol-Version` set to the version agreed; a session is closed with DELETE when done.
 * - Every request goes through the connector's safe fetch (src/lib/connectors/safeFetch.ts): the
 *   manifest's hosts only, its rate limits, no redirects, its timeout and byte cap, and the key
 *   only in Authorization. Failures come back as codes, never the server's words. A refused key
 *   (401 or 403) is token_refused, which marks the connection broken ("access lost").
 */

/** The protocol versions this client speaks; it asks for the first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2025-11-25"] as const;
export const MCP_CLIENT = { name: "YouGrow", version: "1.0.0" } as const;
const ACCEPT = "application/json, text/event-stream";
const SESSION = "mcp-session-id";
/** tools/list is read at most this many pages. */
const MAX_TOOL_PAGES = 3;

/** Where a session calls: the manifest, the connection and the key, as every connector call needs. */
export type McpTarget = Pick<ConnectorCall, "manifest" | "connection" | "token"> & { url: string };

type Fail = HookFailure;
const failed = (code: ConnectorErrorCode, retryAfterSec: number | null = null): Fail => ({ ok: false, code, retryAfterSec });

/** A tool's result, as MCP gives it: its content blocks, its structured content, and whether it is an error. */
export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

/** Every JSON-RPC message in an event stream's `data:` lines, in order. Lines that aren't JSON are skipped. */
export function eventStreamMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n|\r\r/)) {
    const data = event
      .split(/\r?\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* not a JSON message: skipped */
    }
  }
  return out;
}

/** The messages of an answer: one JSON message or a batch, or an event stream's. Null when it is neither. */
export function answerMessages(contentType: string, text: string): unknown[] | null {
  const type = contentType.toLowerCase();
  if (type.includes("text/event-stream")) return eventStreamMessages(text);
  if (type.includes("application/json") || type.includes("+json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }
  return null;
}

type RpcAnswer = { result: unknown } | { error: { code: number } };

/** The response to request `id` among the messages, or null when none answers it. */
export function responseTo(messages: readonly unknown[], id: number): RpcAnswer | null {
  for (const m of messages.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { id?: unknown; result?: unknown; error?: unknown };
    if (msg.id !== id) continue;
    if ("result" in msg) return { result: msg.result };
    if (msg.error && typeof msg.error === "object") return { error: { code: Number((msg.error as { code?: unknown }).code) } };
  }
  return null;
}

/** True once an event stream holds the response to `id`, so the read can end there. */
const answered = (id: number) => (text: string) => responseTo(eventStreamMessages(text), id) !== null;

/** An MCP answer's HTTP failure in the platform's codes: a lost session or missing endpoint is the provider's, not an account. */
function mcpCode(code: ConnectorErrorCode, status: number | null): ConnectorErrorCode {
  if (status === 404) return "provider_error";
  if (status === 405 || status === 406 || status === 415) return "query_refused";
  return code;
}

/** One MCP session: opened with `openMcpSession`, used for a few calls, then closed. */
export class McpSession {
  private nextId = 2;
  constructor(
    private readonly target: McpTarget,
    private readonly deps: ConnectorFetchDeps,
    readonly protocolVersion: string,
    readonly sessionId: string | null,
  ) {}

  private headers(): Record<string, string> {
    return { "mcp-protocol-version": this.protocolVersion, ...(this.sessionId ? { [SESSION]: this.sessionId } : {}) };
  }

  /** One request and its response, or why not. */
  async request(method: string, params: Record<string, unknown>): Promise<{ ok: true; result: unknown } | Fail> {
    const id = this.nextId++;
    return send(this.target, this.deps, { jsonrpc: "2.0", id, method, params }, id, this.headers());
  }

  /** Every tool the server offers, by name (at most a few pages). */
  async listTools(): Promise<{ ok: true; tools: string[] } | Fail> {
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      if (!r.ok) return r;
      const body = r.result as { tools?: unknown; nextCursor?: unknown } | null;
      if (!body || !Array.isArray(body.tools)) return failed("bad_response");
      for (const t of body.tools) if (t && typeof (t as { name?: unknown }).name === "string") tools.push((t as { name: string }).name);
      if (typeof body.nextCursor !== "string" || !body.nextCursor) break;
      cursor = body.nextCursor;
    }
    return { ok: true, tools };
  }

  /**
   * Call one tool. A tool that says it failed (`isError`) is the provider refusing the question;
   * its words, which may echo what was asked, are never kept.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: true; result: McpToolResult } | Fail> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (!r.ok) return r;
    const body = r.result as { content?: unknown; structuredContent?: unknown; isError?: unknown } | null;
    if (!body || typeof body !== "object") return failed("bad_response");
    if (body.isError === true) return failed("query_refused");
    return { ok: true, result: { content: Array.isArray(body.content) ? body.content : [], ...(body.structuredContent !== undefined ? { structuredContent: body.structuredContent } : {}), isError: false } };
  }

  /** End a session the server named (MCP: a client that no longer needs it should DELETE it). Never fails a read. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    await connectorFetch({ ...this.target, method: "DELETE", accept: ACCEPT, headers: this.headers(), text: {} }, this.deps).catch(() => null);
  }
}

/** POST one JSON-RPC message and read the response to `id` (none for a notification). */
async function send(
  target: McpTarget,
  deps: ConnectorFetchDeps,
  message: Record<string, unknown>,
  id: number | null,
  headers: Record<string, string>,
  wantHeaders: readonly string[] = [],
): Promise<{ ok: true; result: unknown; headers: Record<string, string> } | Fail> {
  const res = await connectorFetch(
    {
      manifest: target.manifest,
      connection: target.connection,
      token: target.token,
      url: target.url,
      method: "POST",
      json: message,
      accept: ACCEPT,
      headers,
      text: { headers: wantHeaders, ...(id !== null ? { until: answered(id) } : {}) },
    },
    deps,
  );
  if (!res.ok) return failed(mcpCode(res.code, res.status), res.retryAfterSec);
  const got = res.headers ?? {};
  // A notification is accepted with 202 and nothing more.
  if (id === null) return { ok: true, result: null, headers: got };
  const messages = answerMessages(got["content-type"] ?? "", typeof res.body === "string" ? res.body : "");
  if (!messages) return failed("bad_response");
  const answer = responseTo(messages, id);
  if (!answer) return failed("bad_response");
  // A JSON-RPC error: an unknown tool or method, or arguments the server doesn't take.
  if ("error" in answer) return failed("query_refused");
  return { ok: true, result: answer.result, headers: got };
}

/**
 * Open a session: initialize, check the protocol version the server chose is one this client
 * speaks, keep its session id, and send `notifications/initialized`.
 */
export async function openMcpSession(target: McpTarget, deps: ConnectorFetchDeps = {}): Promise<{ ok: true; session: McpSession } | Fail> {
  const init = await send(
    target,
    deps,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: MCP_CLIENT } },
    1,
    {},
    [SESSION],
  );
  if (!init.ok) return init;
  const version = (init.result as { protocolVersion?: unknown } | null)?.protocolVersion;
  if (typeof version !== "string" || !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return failed("bad_response");
  const raw = init.headers[SESSION];
  // A session id is visible ASCII (MCP, Session Management); anything else is never sent back.
  const sessionId = raw && /^[\x21-\x7e]{1,256}$/.test(raw) ? raw : null;
  if (raw && !sessionId) return failed("bad_response");
  const session = new McpSession(target, deps, version, sessionId);
  const note = await send(target, deps, { jsonrpc: "2.0", method: "notifications/initialized" }, null, { "mcp-protocol-version": version, ...(sessionId ? { [SESSION]: sessionId } : {}) });
  if (!note.ok) return note;
  return { ok: true, session };
}

/** Open a session, run `work` in it, and close it, whatever `work` answered. */
export async function withMcpSession<T extends { ok: boolean }>(target: McpTarget, deps: ConnectorFetchDeps, work: (s: McpSession) => Promise<T | Fail>): Promise<T | Fail> {
  const opened = await openMcpSession(target, deps);
  if (!opened.ok) return opened;
  try {
    return await work(opened.session);
  } finally {
    await opened.session.close();
  }
}
