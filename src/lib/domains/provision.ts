import { normalizeHost } from "./registrableDomain";
import { isReservedHost } from "./reservedHosts";
import { globalOriginConflict } from "./ownership";
import { addAllowedOrigin, removeAllowedOrigin, logDomainGrant } from "@/lib/tenant";
import {
  registerRecaptchaDomain,
  type RegisterDomainResult,
} from "@/lib/security/recaptcha";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DomainOwnership } from "@/lib/types/tenant";

/**
 * Turn a proven-owned custom domain into a working widget host: add its origin to
 * tenant.allowedOrigins (host→tenant routing) AND register it on the reCAPTCHA
 * key (so signups pass the assessment). Ownership MUST already be proven by the
 * caller (email-match / DNS-TXT / Mandrill) — this re-asserts the non-negotiable
 * guards (reserved host, global uniqueness) as defence in depth, then performs
 * the two independent, idempotent provisioning steps. A reCAPTCHA failure does
 * NOT roll back the allowlist write — the result reports partial status so the UI
 * can show "routed, captcha pending" and retry.
 */
export interface ProvisionWebRoutingInput {
  tenantId: string;
  host: string;
  ownership: DomainOwnership;
  /** ISO timestamp (injected for deterministic tests). */
  now: string;
  db?: FirestoreLike;
  /** Override the reCAPTCHA registrar (tests). */
  registrar?: (host: string) => Promise<RegisterDomainResult>;
}

export interface ProvisionWebRoutingResult {
  ok: boolean;
  /** Hard-failure reason: "invalid_host" | "reserved_host" | "origin_conflict". */
  reason?: string;
  origin?: string;
  allowedOriginsAdded?: boolean;
  recaptcha?: RegisterDomainResult;
}

function recaptchaSummary(r: RegisterDomainResult): string {
  if (!r.ok) return r.reason ?? "failed";
  if (r.alreadyPresent) return "already_present";
  if (r.skipped) return "skipped";
  return "added";
}

export async function provisionWebRouting(
  input: ProvisionWebRoutingInput,
): Promise<ProvisionWebRoutingResult> {
  const host = normalizeHost(input.host);
  if (!host) return { ok: false, reason: "invalid_host" };
  if (isReservedHost(host)) return { ok: false, reason: "reserved_host" };

  const origin = `https://${host}`;
  if (await globalOriginConflict(origin, input.tenantId, input.db)) {
    return { ok: false, reason: "origin_conflict" };
  }

  const { added } = await addAllowedOrigin(input.tenantId, origin, input.db);
  const registrar = input.registrar ?? registerRecaptchaDomain;
  const recaptcha = await registrar(host);

  await logDomainGrant(
    {
      tenantId: input.tenantId,
      host,
      action: "grant",
      method: input.ownership.method,
      actorUid: input.ownership.verifiedBy,
      recaptcha: recaptchaSummary(recaptcha),
      createdAt: input.now,
    },
    input.db,
  );

  return { ok: true, origin, allowedOriginsAdded: added, recaptcha };
}

export interface RevokeWebRoutingInput {
  tenantId: string;
  host: string;
  now: string;
  actorUid?: string;
  db?: FirestoreLike;
}

/** Pull a custom domain's origin from allowedOrigins (web routing off) + audit. */
export async function revokeWebRouting(
  input: RevokeWebRoutingInput,
): Promise<{ removed: boolean }> {
  const host = normalizeHost(input.host);
  const origin = `https://${host}`;
  const { removed } = await removeAllowedOrigin(input.tenantId, origin, input.db);
  await logDomainGrant(
    {
      tenantId: input.tenantId,
      host,
      action: "revoke",
      actorUid: input.actorUid,
      createdAt: input.now,
    },
    input.db,
  );
  return { removed };
}
