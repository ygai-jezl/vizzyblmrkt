import { randomUUID } from "node:crypto";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { assertSafeHttpsUrl, safeFetch } from "@/lib/security/ssrf";
import { handleSandboxWebhookRequest } from "./sandbox";
import { signOutboundRequest } from "./outboundSigner";
import type { WebhookPayload } from "./protocol";

/**
 * Send one signed webhook (a platform-signed JWT, direction "webhook" — see
 * outboundToken.ts) to a connected product — e.g.
 * "this user unsubscribed from onboarding tips", so the product can mirror it.
 * Same transport rules as the context client: SSRF-safe, https:443, no redirects,
 * 5 s; a sandbox is delivered in-process to its reference receiver. Delivery
 * retries/backoff belong to the caller's queue (lifecycle runtime); this sends once.
 */

export type WebhookResult = { ok: true; status: number } | { ok: false; error: string };

export async function sendConnectionWebhook(
  connection: ProductConnection,
  event: { type: WebhookPayload["type"]; data: Record<string, unknown> },
  deps: { fetchImpl?: typeof safeFetch; db?: FirestoreLike; nowMs?: number } = {},
): Promise<WebhookResult> {
  const endpoint = connection.webhookEndpoint;
  if (!endpoint?.enabled || !endpoint.url) return { ok: false, error: "not_configured" };
  if (connection.status === "revoked") return { ok: false, error: "not_configured" };

  const nowMs = deps.nowMs ?? Date.now();
  const payload: WebhookPayload = {
    id: `wh_${randomUUID()}`,
    type: event.type,
    createdAt: new Date(nowMs).toISOString(),
    data: event.data,
  };
  const body = JSON.stringify(payload);
  let headers: Record<string, string>;
  try {
    headers = await signOutboundRequest({ audience: connection.keyId, direction: "webhook", jti: payload.id, rawBody: body, nowMs });
  } catch {
    return { ok: false, error: "signing_unavailable" };
  }
  const init = { method: "POST", headers, body };

  try {
    let res: Response;
    if (connection.kind === "sandbox") {
      res = await handleSandboxWebhookRequest(new Request(endpoint.url, init), connection.id, {
        db: deps.db,
        nowMs,
      });
    } else {
      assertSafeHttpsUrl(endpoint.url, { allowedPorts: [443] });
      res = await (deps.fetchImpl ?? safeFetch)(endpoint.url, init, {
        maxRedirects: 0,
        timeoutMs: 5000,
        allowedPorts: [443],
      });
    }
    await res.body?.cancel().catch(() => {});
    return res.ok ? { ok: true, status: res.status } : { ok: false, error: `http_${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "network" };
  }
}
