import type { KnowledgeChunkSource } from "@/lib/types/knowledgeBase";

/**
 * First-line validation of an operator-supplied ingest URL. This is a CHEAP
 * front-door guard (defence in depth) — the worker MUST still re-resolve and
 * re-check the host at fetch/clone time, because DNS can rebind between this
 * check and the worker's request. We:
 *  - require https,
 *  - block loopback / private / link-local / metadata hosts by literal form,
 *  - pin git sources to their known hosts (self-hosted GitLab is deferred).
 */

export type IngestUrlError =
  | "invalid_url"
  | "scheme_not_https"
  | "host_not_allowed"
  | "host_blocked";

const BLOCKED_HOST_LITERALS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata",
  "metadata.google.internal",
  "169.254.169.254",
]);

/** Literal-form private/link-local IP ranges (string-prefix screen, not a DNS resolve). */
function isPrivateHostLiteral(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_HOST_LITERALS.has(h)) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 private / link-local ranges.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  // IPv6 loopback / unique-local / link-local.
  if (h.startsWith("[")) {
    const inner = h.replace(/^\[|\]$/g, "");
    if (inner === "::1" || inner.startsWith("fc") || inner.startsWith("fd") || inner.startsWith("fe80")) {
      return true;
    }
  }
  return false;
}

const GIT_HOSTS: Record<"github" | "gitlab", Set<string>> = {
  github: new Set(["github.com", "www.github.com"]),
  gitlab: new Set(["gitlab.com", "www.gitlab.com"]),
};

export type ValidateUrlResult =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: IngestUrlError };

export function validateIngestUrl(
  raw: string,
  source: KnowledgeChunkSource,
): ValidateUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "scheme_not_https" };
  const host = parsed.hostname.toLowerCase();
  if (!host || isPrivateHostLiteral(host)) return { ok: false, reason: "host_blocked" };
  if (source === "github" || source === "gitlab") {
    if (!GIT_HOSTS[source].has(host)) return { ok: false, reason: "host_not_allowed" };
  }
  return { ok: true, url: parsed.toString(), host };
}
