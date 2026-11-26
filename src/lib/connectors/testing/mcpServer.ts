import type { ConnectorManifestInput } from "../manifest";
import type { Transport } from "../safeFetch";

/**
 * A made-up remote MCP server for tests (ADR-0019), answering through the connectors' transport
 * stub, so nothing reaches the network. It speaks Streamable HTTP as the MCP specification
 * describes: initialize, notifications/initialized, tools/list and tools/call, answering each
 * request as one JSON message or as an event stream, and naming a session when asked to.
 */

/** What a tool answers: data (sent as the JSON text of its first content block), or an error. */
export type FakeToolAnswer = unknown | { isError: true; text: string };

export interface FakeMcpOptions {
  /** Each tool by name: its answer for the arguments it was called with. */
  tools: Record<string, (args: Record<string, unknown>) => FakeToolAnswer>;
  /** Answer requests with an event stream instead of JSON. */
  sse?: boolean;
  /** Leave the event stream open after the answer, as a server may. */
  keepOpen?: boolean;
  /** Name a session in Mcp-Session-Id and expect it back on every later request. */
  sessionId?: string;
  /** The protocol version initialize answers with (the one asked for by default). */
  protocolVersion?: string;
  /** Answer every request with this HTTP status and a JSON error body. */
  status?: number;
  /** Send the tool's data as structuredContent instead of text. */
  structured?: boolean;
  /** Put words around the JSON text, as a server marking content untrusted does. */
  wrap?: boolean;
}

/** One request as the server saw it. */
export interface FakeMcpRequest {
  url: string;
  httpMethod: string;
  method: string | null;
  id: unknown;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

export const isToolError = (a: unknown): a is { isError: true; text: string } => !!a && typeof a === "object" && (a as { isError?: unknown }).isError === true;

/** A fake MCP server: its transport for connector deps, and every request it saw. */
export function fakeMcpServer(opts: FakeMcpOptions) {
  const requests: FakeMcpRequest[] = [];
  const transport: Transport = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? (JSON.parse(String(init.body)) as { id?: unknown; method?: string; params?: Record<string, unknown> }) : {};
    requests.push({ url, httpMethod: String(init.method ?? "GET"), method: body.method ?? null, id: body.id, params: body.params ?? {}, headers });
    if (opts.status) return new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "made-up refusal" } }), { status: opts.status, headers: { "content-type": "application/json" } });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (!String(headers.accept ?? "").includes("text/event-stream") || !String(headers.accept ?? "").includes("application/json")) return new Response("{}", { status: 406, headers: { "content-type": "application/json" } });
    if (body.method !== "initialize" && opts.sessionId && headers["mcp-session-id"] !== opts.sessionId) return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
    // A notification is accepted, with nothing to answer.
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    let error: { code: number; message: string } | null = null;
    if (body.method === "initialize") {
      result = { protocolVersion: opts.protocolVersion ?? body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "made-up", version: "0.0.1" } };
    } else if (body.method === "tools/list") {
      result = { tools: Object.keys(opts.tools).map((name) => ({ name, inputSchema: { type: "object" } })) };
    } else if (body.method === "tools/call") {
      const name = String(body.params?.name ?? "");
      const tool = opts.tools[name];
      if (!tool) error = { code: -32602, message: `Tool ${name} not found` };
      else {
        const answer = tool((body.params?.arguments ?? {}) as Record<string, unknown>);
        if (isToolError(answer)) result = { content: [{ type: "text", text: answer.text }], isError: true };
        else if (opts.structured) result = { content: [{ type: "text", text: "see structured content" }], structuredContent: answer };
        else {
          const text = JSON.stringify(answer, null, 2);
          result = { content: [{ type: "text", text: opts.wrap ? `The content below is made-up data.\n<untrusted_content>\n${text}\n</untrusted_content>` : text }] };
        }
      }
    } else error = { code: -32601, message: "Method not found" };
    const message = error ? { jsonrpc: "2.0", id: body.id, error } : { jsonrpc: "2.0", id: body.id, result };
    const session: Record<string, string> = body.method === "initialize" && opts.sessionId ? { "mcp-session-id": opts.sessionId } : {};
    if (!opts.sse) return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", ...session } });
    // An event stream: a progress notification first, then the answer.
    const events = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
        if (!opts.keepOpen) controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...session } });
  };
  return { transport, requests };
}

/** The tools/call requests a server saw, with their tool and arguments. */
export const toolCalls = (requests: readonly FakeMcpRequest[]) =>
  requests.filter((r) => r.method === "tools/call").map((r) => ({ name: String(r.params.name), args: (r.params.arguments ?? {}) as Record<string, unknown> }));

/** The made-up server's endpoint. */
export const MCP_TEST_URL = "https://mcp.example.test/v1/mcp";
const URL_ = MCP_TEST_URL;

/**
 * A made-up MCP connector, data only, for the engine's and the readers' tests: a stream collected
 * by day, one read for one page, and one whose numbers are as they stand.
 */
export const testMcpManifest = {
  schema: 1,
  id: "acme-answers",
  name: "Acme Answers",
  summary: "Made-up numbers from a made-up MCP server.",
  category: "search",
  publisher: "yougrow",
  switch: "CONNECTOR_ACME_ANSWERS_ENABLED",
  connect: [
    {
      method: "mcp",
      url: URL_,
      auth: { kind: "bearer", field: { key: "apiKey", label: "API key", secret: true, pattern: "^[A-Za-z0-9_]+$", minLength: 10, maxLength: 200 } },
      verify: { tool: "who_am_i", account: "site", label: "name" },
      permissions: ["Read only"],
      steps: ["Make a key that can only read, then paste it here."],
    },
  ],
  api: { hosts: ["mcp.example.test"], limits: { connection: { perMinute: 30, perHour: 300 }, brand: { perMinute: 30, perHour: 300 } }, timeoutMs: 10_000, maxBytes: 512 * 1024 },
  verify: { method: "POST", url: URL_, hook: "mcp.verify" },
  shares: [
    { what: "Daily numbers", direction: "read", where: "Read live when you ask.", needs: ["Read only"] },
    { what: "Anything else", direction: "never", where: "Nothing is ever written." },
  ],
  produces: [
    {
      stream: "daily",
      description: "A made-up count a day.",
      shape: "numbers",
      keys: ["day"],
      measures: ["cfRequests"],
      joins: { day: "day" },
      lagDays: 1,
      timeZone: "UTC",
      personal: false,
      liveBy: ["day"],
      collect: { by: ["day"], rowsPerDay: 500, keepDays: 90, where: "Kept 90 days.", lag: "Each day is collected a day later." },
      mcp: { tool: "history", fill: { startDate: "from", endDate: "to", limit: "limit" }, rows: "data", more: "pagination.hasMore", keys: { day: "date" }, measures: { cfRequests: "count" } },
    },
    {
      stream: "pages",
      description: "A made-up count for one page.",
      shape: "numbers",
      keys: ["page", "engines"],
      measures: ["cfPageViews"],
      joins: { page: "page" },
      lagDays: 1,
      personal: false,
      liveBy: ["page"],
      liveFilters: ["page"],
      mcp: { tool: "cited", args: { limit: 50 }, fill: { url: "pageUrl" }, rows: "data", keys: { page: "url", engines: "engines" }, measures: { cfPageViews: "count" } },
    },
    {
      stream: "now",
      description: "Made-up numbers as they stand.",
      shape: "numbers",
      keys: ["prompt"],
      measures: ["cfVisits"],
      joins: { prompt: "topic" },
      lagDays: 1,
      personal: false,
      liveBy: ["topic"],
      mcp: { tool: "prompts", rows: "data", more: "pagination.hasMore", keys: { prompt: "text" }, measures: { cfVisits: "metrics.total" } },
    },
  ],
  uses: ["vizzy.read"],
  hooks: { live: "mcp.live", collect: "mcp.collect" },
  disconnect: "Disconnecting deletes the key YouGrow keeps.",
} satisfies ConnectorManifestInput;

