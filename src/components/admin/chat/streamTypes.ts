/**
 * Normalized streaming event vocabulary shared by the agent proxy
 * (src/app/api/admin/agent/chat/route.ts) and the client hook
 * (useDashboardChat). The proxy re-frames the raw Vertex `:streamQuery` SSE
 * (content.parts: text | thought | functionCall | functionResponse) into these
 * events so the client never parses Vertex's wire format directly.
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_start"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result?: Record<string, unknown> }
  | { type: "done"; sessionId?: string; thoughtText?: string }
  | { type: "error"; message?: string };

/**
 * Parse one SSE record (the text between `\n\n` boundaries) into a StreamEvent.
 * Concatenates multiple `data:` lines (per the SSE spec) and JSON-parses the
 * payload. Returns null for comments, heartbeats, `[DONE]`, or malformed JSON.
 */
export function parseSSE(part: string): StreamEvent | null {
  const dataLines = part
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as StreamEvent;
  } catch {
    return null;
  }
}
