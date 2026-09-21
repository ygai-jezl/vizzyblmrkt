import { randomUUID } from "node:crypto";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { assertSafeHttpsUrl, readBytesCapped, safeFetch } from "@/lib/security/ssrf";
import { registrableDomain } from "@/lib/domains/registrableDomain";
import { currentSecret } from "./keys";
import { handleSandboxContextRequest } from "./sandbox";
import {
  ContextResponseSchema,
  LIMITS,
  signedHeaders,
  zodReason,
  type ContextPurpose,
  type ProductContext,
} from "./protocol";

/**
 * Pull fresh context (onboarding steps, facts, insight candidates) for one user
 * from a connected product — the "context pull" half of the connection. The
 * request is signed (direction "context"); the product verifies it like the
 * sandbox reference endpoint does.
 *
 * A real product's URL is tenant-supplied, so it goes through the SSRF-safe fetch:
 * https on port 443 only, a connect-time public-IP check, NO redirects, a ≤5 s
 * timeout and a 64 KB response cap, then a strict schema. Links the product
 * returns (step deep links) are kept only when https and on the connection's
 * allowed link domains. A sandbox connection is served in-process by its
 * reference handler (same verification code, no network).
 */

export type ContextError =
  | "not_configured"
  | "blocked_url"
  | "timeout"
  | "network"
  | "too_large"
  | "bad_json"
  | "bad_schema"
  | `http_${number}`;

export type ContextResult =
  | { ok: true; context: ProductContext; warnings: string[]; latencyMs: number }
  | { ok: false; error: ContextError; detail?: string; latencyMs: number };

export interface ContextRequestInput {
  userId: string;
  purpose: ContextPurpose;
  journeyId?: string | null;
  nodeId?: string | null;
}

export interface ContextClientDeps {
  /** Transport for real products (tests inject a stub). */
  fetchImpl?: typeof safeFetch;
  db?: FirestoreLike;
  nowMs?: number;
}

/** True when `url` is https and on one of the allowed registrable domains. */
export function isAllowedLink(url: string, linkDomains: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = registrableDomain(u.hostname);
  if (!host) return false;
  return linkDomains.some((d) => registrableDomain(d) === host);
}

function classify(err: unknown): ContextError {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (/ssrf_blocked|host_blocked|port_blocked|scheme_not_https|invalid_url|too_many_redirects/.test(msg)) {
    return "blocked_url";
  }
  return "network";
}

export async function fetchProductContext(
  connection: ProductConnection,
  input: ContextRequestInput,
  deps: ContextClientDeps = {},
): Promise<ContextResult> {
  const started = Date.now();
  const done = <T extends object>(r: T) => ({ ...r, latencyMs: Date.now() - started });
  const endpoint = connection.contextEndpoint;
  if (!endpoint?.enabled || !endpoint.url) return done({ ok: false as const, error: "not_configured" as const });

  let secret: string | null;
  try {
    secret = currentSecret(connection);
  } catch {
    secret = null;
  }
  if (!secret) return done({ ok: false as const, error: "not_configured" as const });

  const nowMs = deps.nowMs ?? Date.now();
  const body = JSON.stringify({ ...input, requestId: randomUUID() });
  const init = { method: "POST", headers: signedHeaders(connection.keyId, secret, "context", body, nowMs), body };

  let res: Response;
  try {
    if (connection.kind === "sandbox") {
      res = await handleSandboxContextRequest(new Request(endpoint.url, init), connection.id, {
        db: deps.db,
        nowMs,
      });
    } else {
      assertSafeHttpsUrl(endpoint.url, { allowedPorts: [443] });
      res = await (deps.fetchImpl ?? safeFetch)(endpoint.url, init, {
        maxRedirects: 0,
        timeoutMs: endpoint.timeoutMs,
        allowedPorts: [443],
      });
    }
  } catch (err) {
    return done({ ok: false as const, error: classify(err), detail: err instanceof Error ? err.message.slice(0, 200) : undefined });
  }
  if (!res.ok) return done({ ok: false as const, error: `http_${res.status}` as const });

  const bytes = await readBytesCapped(res, LIMITS.maxContextBytes).catch(() => null);
  if (!bytes) return done({ ok: false as const, error: "too_large" as const });
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return done({ ok: false as const, error: "bad_json" as const });
  }
  const parsed = ContextResponseSchema.safeParse(json);
  if (!parsed.success) return done({ ok: false as const, error: "bad_schema" as const, detail: zodReason(parsed.error) });

  // Drop any link the product returned that isn't https on an allowed domain.
  const warnings: string[] = [];
  const context = parsed.data;
  const steps = context.steps.map((s) => {
    if (s.url && !isAllowedLink(s.url, connection.linkDomains)) {
      warnings.push(`link_dropped:${s.id}`);
      return { ...s, url: null };
    }
    return s;
  });
  let nextStep = context.nextStep ?? null;
  if (nextStep?.url && !isAllowedLink(nextStep.url, connection.linkDomains)) {
    warnings.push(`link_dropped:next:${nextStep.id}`);
    nextStep = { ...nextStep, url: null };
  }
  return done({ ok: true as const, context: { ...context, steps, nextStep }, warnings });
}

/** Record a context pull's outcome on the connection (advisory health). */
export async function recordContextHealth(
  ctx: TenantContext,
  connection: ProductConnection,
  result: ContextResult,
  db?: FirestoreLike,
): Promise<void> {
  const now = new Date().toISOString();
  const health = result.ok
    ? { ...connection.health, lastContextOkAt: now, lastContextError: null, consecutiveContextFailures: 0 }
    : {
        ...connection.health,
        lastContextError: result.error,
        consecutiveContextFailures: (connection.health?.consecutiveContextFailures ?? 0) + 1,
      };
  await forTenant(ctx, db).productConnections.update(connection.id, { health }).catch(() => {});
}
