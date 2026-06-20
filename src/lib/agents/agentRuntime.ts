import { GoogleAuth } from "google-auth-library";
import type { TenantContext } from "@/lib/tenant/types";
import type { ChatMode } from "@/components/admin/chat/chatModes";

/**
 * Server-side client for the deployed root agent on the Gemini Enterprise Agent
 * Platform / Agent Runtime (a reasoningEngine). Encapsulates ADC token minting,
 * endpoint construction, the `[ctx:{…}]` context envelope, Memory Bank scoping,
 * and the Vertex-SSE → normalized-event re-framer. Used only from server routes
 * (src/app/api/admin/agent/*) — never the browser.
 *
 * Vertex `:streamQuery` rejects unknown root-level request fields, so tenant/user
 * context and the reasoning mode ride as a prefix on the message text and are
 * stripped agent-side by the before_model_callbacks (see agents/root_agent).
 */

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let _auth: GoogleAuth | null = null;
function authClient(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return _auth;
}

/** Region the reasoningEngine is DEPLOYED in (not the model's GOOGLE_CLOUD_LOCATION). */
export function agentLocation(): string {
  return process.env.ROOT_AGENT_LOCATION ?? "us-central1";
}

/** True once the agent has been deployed and its resource id wired into env. */
export function isAgentRuntimeConfigured(): boolean {
  return Boolean(process.env.ROOT_AGENT_RESOURCE_ID && process.env.GOOGLE_CLOUD_PROJECT);
}

/** Mint a Google access token via ADC (App Hosting runtime SA in prod). */
export async function getAccessToken(): Promise<string> {
  const token = await authClient().getAccessToken();
  if (!token) throw new Error("agent_runtime_no_access_token");
  return token;
}

export function reasoningEngineUrl(
  method: "streamQuery" | "query",
  sse = false,
): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const resourceId = process.env.ROOT_AGENT_RESOURCE_ID;
  if (!project || !resourceId) throw new Error("agent_runtime_not_configured");
  const location = agentLocation();
  // v1beta1, NOT v1: reasoningEngines :query/:streamQuery only serve on the
  // v1beta1 endpoint for `adk deploy agent_engine` agents — the v1 path returns
  // an HTML 404 at the gateway (this is what the Agent Platform SDK uses too).
  const base =
    `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}` +
    `/locations/${location}/reasoningEngines/${resourceId}:${method}`;
  return sse ? `${base}?alt=sse` : base;
}

/**
 * Build the `[ctx:{…}] [mode:…] ` prefix the agent's callbacks consume + strip.
 *
 * `extras` can carry a signed canvas capability token (`ctxToken`) and the active
 * `campaignId` so the Campaign Ops sub-agent can author a journey draft. Both
 * MUST be brace-free strings — the agent-side envelope parser regex is
 * non-greedy and a nested `}` would truncate the JSON (see context_envelope.py).
 * The Python callback writes every key into session state generically, so no
 * agent-side change is needed to surface them.
 */
export function contextEnvelope(
  ctx: TenantContext,
  traceId: string,
  mode?: ChatMode,
  extras?: { ctxToken?: string | null; campaignId?: string | null },
): string {
  const payload: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    region: ctx.region,
    traceId,
  };
  if (extras?.ctxToken) payload.ctxToken = extras.ctxToken;
  if (extras?.campaignId) payload.campaignId = extras.campaignId;
  const modePrefix = mode ? `[mode:${mode}] ` : "";
  return `[ctx:${JSON.stringify(payload)}] ${modePrefix}`;
}

/** Memory Bank scope key — composite prevents cross-tenant memory bleed. */
export function compositeUserId(ctx: TenantContext): string {
  return `${ctx.tenantId}_${ctx.userId}`;
}

/** Invoke a non-streaming class_method (session/memory ops) via `:query`. */
export async function callClassMethod<T = unknown>(
  method: string,
  input: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(reasoningEngineUrl("query"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ class_method: method, input }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`agent_runtime_${method}_${res.status}: ${detail}`.trim());
  }
  return (await res.json()) as T;
}

// ── Session helpers ──────────────────────────────────────────────────────────

/** Defensively pull a session id out of varying Agent Runtime response shapes. */
function extractSessionId(payload: unknown): string | null {
  const obj = payload as Record<string, unknown> | null;
  const output = (obj?.output ?? obj) as Record<string, unknown> | undefined;
  const id = output?.id ?? output?.sessionId ?? output?.session_id;
  return typeof id === "string" ? id : null;
}

export async function createAgentSession(userId: string): Promise<string | null> {
  const out = await callClassMethod("async_create_session", { user_id: userId });
  return extractSessionId(out);
}

export async function listAgentSessions(userId: string): Promise<unknown> {
  return callClassMethod("async_list_sessions", { user_id: userId });
}

export async function getAgentSession(
  userId: string,
  sessionId: string,
): Promise<unknown> {
  return callClassMethod("async_get_session", {
    user_id: userId,
    session_id: sessionId,
  });
}

// ── Vertex SSE re-framing ──────────────────────────────────────────────────────

/**
 * Normalized event the browser consumes. MUST stay in sync with the client's
 * StreamEvent union in src/components/admin/chat/streamTypes.ts.
 */
export type NormalizedAgentEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_start"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result?: Record<string, unknown> };

type VertexPart = {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  function_call?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
  function_response?: { name?: string; response?: Record<string, unknown> };
};
type VertexEvent = {
  content?: { role?: string; parts?: VertexPart[] };
  partial?: boolean;
};

/**
 * Map one Vertex stream event to zero+ normalized events.
 *
 * Text dedup is best-effort: Agent Runtime may stream partial text deltas and
 * then a consolidated non-partial copy of the same turn. We forward deltas and
 * skip the trailing consolidated duplicate (tracked via `sawPartialText`, reset
 * by the caller on each tool boundary). Verify/adjust against a live stream on
 * first deploy — see plan §Phase 2.
 */
export function mapVertexEvent(
  evt: VertexEvent,
  state: { sawPartialText: boolean },
): NormalizedAgentEvent[] {
  const out: NormalizedAgentEvent[] = [];
  const role = evt.content?.role;
  const parts = evt.content?.parts ?? [];
  const isPartial = evt.partial === true;

  for (const part of parts) {
    if (part.thought === true && part.text) {
      out.push({ type: "thought", text: part.text });
      continue;
    }
    if (part.text && role === "model") {
      if (!isPartial && state.sawPartialText) {
        // consolidated duplicate of already-streamed deltas — skip
      } else {
        out.push({ type: "text", text: part.text });
        if (isPartial) state.sawPartialText = true;
      }
    }
    const fc = part.functionCall ?? part.function_call;
    if (fc) {
      out.push({ type: "tool_start", toolName: fc.name ?? "tool", args: fc.args ?? {} });
      state.sawPartialText = false; // new turn after a tool call
    }
    const fr = part.functionResponse ?? part.function_response;
    if (fr) {
      out.push({ type: "tool_result", toolName: fr.name ?? "tool", result: fr.response ?? {} });
    }
  }
  return out;
}

/** Parse a raw upstream chunk (SSE `data:` lines OR NDJSON) into JSON events. */
export function parseUpstreamRecords(records: string[]): VertexEvent[] {
  const events: VertexEvent[] = [];
  for (const raw of records) {
    let line = raw.trim();
    if (!line || line === "[DONE]") continue;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    else if (line.startsWith("event:") || line.startsWith(":")) continue;
    if (!line || line === "[DONE]") continue;
    try {
      events.push(JSON.parse(line) as VertexEvent);
    } catch {
      // partial/non-JSON line — skip
    }
  }
  return events;
}
