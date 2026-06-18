import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  getSenderConfig,
  mutateSenderConfig,
  normalizeDomain,
} from "@/lib/admin/senderConfig";
import {
  addSendingDomain,
  applyRecordValidity,
  checkSendingDomain,
  senderDnsRecords,
  mandrillConfigured,
} from "@/lib/email/senderDomains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `background: true` marks an unattended auto-poll (vs an explicit Verify click). */
const VerifySchema = z.object({ domain: z.string(), background: z.boolean().optional() });

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

  // Only senders/add-domain mints the ownership token; backfill it for legacy
  // domains added before a provider existed. Skip it on background auto-polls —
  // those run check-domain (which also returns the token) every tick, so reserve
  // the extra add-domain round-trip for an explicit Verify click and avoid
  // hammering the provider for a domain that never gets a key.
  let verifyTxtKey = target.verifyTxtKey;
  if (!verifyTxtKey && !parsed.data.background) {
    const added = await addSendingDomain(domain);
    verifyTxtKey = added.verifyTxtKey;
  }

  const checked = await checkSendingDomain(domain);
  verifyTxtKey = verifyTxtKey ?? checked.verifyTxtKey;
  const now = new Date().toISOString();

  // Atomic per-domain write: re-find the domain in the FRESH config so a
  // concurrent writer (e.g. the web-routing DNS challenge persisting dnsTxtToken,
  // or another verify tick) isn't clobbered by a stale full-array overwrite.
  const next = await mutateSenderConfig(ctx.tenantId, (cur) => {
    const fresh = cur.domains.find((d) => d.domain === domain);
    if (!fresh) return cur; // removed concurrently — nothing to update
    const updated = {
      ...fresh,
      status: checked.status,
      dkimValid: checked.dkimValid,
      spfValid: checked.spfValid,
      // Regenerate from scratch so legacy single-TXT DKIM rows heal to the CNAME set.
      records: applyRecordValidity(senderDnsRecords(domain, verifyTxtKey), checked),
      lastCheckedAt: now,
      ...(verifyTxtKey ? { verifyTxtKey } : {}),
      ...(checked.detail ? { detail: checked.detail } : { detail: undefined }),
    };
    return { ...cur, domains: cur.domains.map((d) => (d.domain === domain ? updated : d)) };
  });

  return NextResponse.json({
    ok: checked.ok,
    reason: checked.detail,
    domains: next.domains,
    providerConfigured: true,
  });
}
