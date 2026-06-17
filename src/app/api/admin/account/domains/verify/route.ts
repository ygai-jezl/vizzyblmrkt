import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  getSenderConfig,
  saveSenderConfig,
  normalizeDomain,
} from "@/lib/admin/senderConfig";
import {
  applyRecordValidity,
  checkSendingDomain,
  mandrillConfigured,
} from "@/lib/email/senderDomains";
import type { EmailSenderConfig } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VerifySchema = z.object({ domain: z.string() });

/**
 * Re-run the provider's DKIM/SPF checks for a domain and persist the verdict.
 * When the provider isn't configured, returns the domain unchanged with a clear
 * reason so the UI can explain why live verification is unavailable.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = VerifySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const domain = normalizeDomain(parsed.data.domain);

  const config = await getSenderConfig(ctx.tenantId);
  const target = config.domains.find((d) => d.domain === domain);
  if (!target) {
    return NextResponse.json({ error: "domain_not_found" }, { status: 404 });
  }

  if (!mandrillConfigured()) {
    return NextResponse.json({
      ok: false,
      reason: "provider_not_configured",
      domains: config.domains,
      providerConfigured: false,
    });
  }

  const checked = await checkSendingDomain(domain);
  const now = new Date().toISOString();
  const updated = {
    ...target,
    status: checked.status,
    dkimValid: checked.dkimValid,
    spfValid: checked.spfValid,
    records: applyRecordValidity(target.records, checked),
    lastCheckedAt: now,
    ...(checked.detail ? { detail: checked.detail } : { detail: undefined }),
  };

  const next: EmailSenderConfig = {
    ...config,
    domains: config.domains.map((d) => (d.domain === domain ? updated : d)),
  };
  await saveSenderConfig(ctx.tenantId, next);

  return NextResponse.json({
    ok: checked.ok,
    reason: checked.detail,
    domains: next.domains,
    providerConfigured: true,
  });
}
