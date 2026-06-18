import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getSenderConfig, saveSenderConfig } from "@/lib/admin/senderConfig";
import { normalizeHost } from "@/lib/domains/registrableDomain";
import { isReservedHost } from "@/lib/domains/reservedHosts";
import {
  tryEmailFastPath,
  issueDnsTxtToken,
  dnsChallengeRecord,
  verifyDnsTxt,
} from "@/lib/domains/ownership";
import { provisionWebRouting, revokeWebRouting } from "@/lib/domains/provision";
import type {
  DomainOwnership,
  EmailSenderConfig,
  SenderDomain,
} from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enable / disable the WEB-ROUTING capability on a domain the tenant already
 * added in Account Settings → Domains. Enabling proves ownership (email-match
 * fast-path → Mandrill-verified → DNS-TXT challenge) and then auto-provisions the
 * origin into allowedOrigins + the reCAPTCHA key (see src/lib/domains/provision).
 * Kept separate from the email add/verify route so the two capabilities evolve
 * independently.
 */

const Body = z.object({ domain: z.string() });

async function requireCtx() {
  const ctx = await getAdminContext();
  return ctx?.userId ? ctx : null;
}

function findDomain(config: EmailSenderConfig, host: string): SenderDomain | undefined {
  return config.domains.find((d) => normalizeHost(d.domain) === host);
}

function replaceDomain(
  config: EmailSenderConfig,
  next: SenderDomain,
): EmailSenderConfig {
  return {
    ...config,
    domains: config.domains.map((d) =>
      normalizeHost(d.domain) === normalizeHost(next.domain) ? next : d,
    ),
  };
}

/** Enable web routing (prove ownership → provision). */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const host = normalizeHost(parsed.data.domain);
  if (!host) return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
  if (isReservedHost(host)) {
    return NextResponse.json({ error: "reserved_domain" }, { status: 400 });
  }

  const config = await getSenderConfig(ctx.tenantId);
  const entry = findDomain(config, host);
  if (!entry) {
    return NextResponse.json({ error: "domain_not_added" }, { status: 404 });
  }
  if (entry.capabilities?.webRouting) {
    return NextResponse.json({ ok: true, domain: entry, alreadyEnabled: true });
  }

  const now = new Date().toISOString();

  // 1) Prove ownership — fast path, then Mandrill-verified, then DNS-TXT.
  let ownership: DomainOwnership | null = null;
  const fast = tryEmailFastPath(host, ctx);
  if (fast.ok) {
    ownership = { method: "email_match", verifiedAt: now, verifiedBy: ctx.userId!, evidence: fast.evidence };
  } else if (entry.status === "verified") {
    // Publishing Mandrill's DKIM/ownership records already proved DNS control.
    ownership = { method: "mandrill_dns", verifiedAt: now, verifiedBy: ctx.userId!, evidence: "mandrill" };
  } else {
    // DNS-TXT challenge: issue on first ask, verify on the follow-up.
    const token = entry.dnsTxtToken ?? issueDnsTxtToken();
    if (!entry.dnsTxtToken) {
      await saveSenderConfig(ctx.tenantId, replaceDomain(config, { ...entry, dnsTxtToken: token }));
      return NextResponse.json({
        ok: false,
        needsDns: true,
        reason: fast.reason,
        record: dnsChallengeRecord(host, token),
      });
    }
    const verified = await verifyDnsTxt(host, token);
    if (!verified.ok) {
      return NextResponse.json({
        ok: false,
        needsDns: true,
        reason: verified.detail ?? "txt_not_found",
        record: dnsChallengeRecord(host, token),
      });
    }
    ownership = { method: "dns_txt", verifiedAt: now, verifiedBy: ctx.userId!, evidence: dnsChallengeRecord(host, token).host };
  }

  // 2) Provision allowedOrigins + reCAPTCHA (defence-in-depth re-checks inside).
  const result = await provisionWebRouting({ tenantId: ctx.tenantId, host, ownership, now });
  if (!result.ok) {
    return NextResponse.json({ error: "provision_failed", reason: result.reason }, { status: 400 });
  }

  // 3) Persist the capability + ownership on the domain entry.
  const updated: SenderDomain = {
    ...entry,
    ownership,
    capabilities: { email: entry.capabilities?.email ?? false, webRouting: true },
    dnsTxtToken: undefined,
    revokedAt: undefined,
  };
  await saveSenderConfig(ctx.tenantId, replaceDomain(await getSenderConfig(ctx.tenantId), updated));

  return NextResponse.json({
    ok: true,
    domain: updated,
    provisioning: { origin: result.origin, recaptcha: result.recaptcha },
  });
}

/** Disable web routing (pull origin from allowedOrigins). */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const host = normalizeHost(parsed.data.domain);
  const config = await getSenderConfig(ctx.tenantId);
  const entry = findDomain(config, host);
  if (!entry) return NextResponse.json({ error: "domain_not_added" }, { status: 404 });

  const now = new Date().toISOString();
  await revokeWebRouting({ tenantId: ctx.tenantId, host, now, actorUid: ctx.userId });

  const updated: SenderDomain = {
    ...entry,
    capabilities: { email: entry.capabilities?.email ?? false, webRouting: false },
    revokedAt: now,
  };
  await saveSenderConfig(ctx.tenantId, replaceDomain(await getSenderConfig(ctx.tenantId), updated));
  return NextResponse.json({ ok: true, domain: updated });
}
