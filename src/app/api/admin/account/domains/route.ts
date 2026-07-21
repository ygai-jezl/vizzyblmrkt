import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  getSenderConfig,
  saveSenderConfig,
  mutateSenderConfig,
  normalizeDomain,
  isValidDomain,
} from "@/lib/admin/senderConfig";
import {
  senderDnsRecords,
  applyRecordValidity,
  addSendingDomain,
  checkSendingDomain,
  mandrillConfigured,
} from "@/lib/email/senderDomains";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { deriveFaviconUrl } from "@/lib/tenant/favicon";
import type { EmailSenderConfig, SenderDomain } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shape returned to the Account Settings → Domains UI. */
function present(config: EmailSenderConfig) {
  return {
    senderName: config.senderName ?? "",
    fromLocalPart: config.fromLocalPart ?? "",
    fromDomain: config.fromDomain ?? "",
    replyTo: config.replyTo ?? "",
    privacyPolicyUrl: config.privacyPolicyUrl ?? "",
    domains: config.domains ?? [],
    providerConfigured: mandrillConfigured(),
  };
}

async function requireCtx() {
  const ctx = await getAdminContext();
  if (!ctx) return null;
  return ctx;
}

/** Read the tenant's sender config + verified domains. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const config = await getSenderConfig(ctx.tenantId);
  const tenant = await getTenantById(ctx.tenantId);
  // rootDomain is the brand's primary WEBSITE (bare host) — distinct from the sending
  // sub-domains above; surfaced here so it's editable and can ground AI brand-voice gen.
  return NextResponse.json({ ...present(config), rootDomain: tenant?.rootDomain ?? "" });
}

/**
 * Update the brand's PRIMARY DOMAIN (`tenant.rootDomain`) — the marketing website host,
 * NOT a sending sub-domain. Decoupled from the sender-identity PUT (which requires a privacy
 * policy) so setting the primary domain never demands unrelated fields. Re-derives the favicon
 * from the new host (it's derived from rootDomain, with no separate custom-favicon setter).
 */
const PrimaryDomainSchema = z.object({ rootDomain: z.string().max(253) });
export async function PATCH(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = PrimaryDomainSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const rootDomain = normalizeDomain(parsed.data.rootDomain);
  if (!isValidDomain(rootDomain)) return NextResponse.json({ error: "invalid_domain" }, { status: 400 });

  await updateTenantConfig(ctx.tenantId, { rootDomain, faviconUrl: deriveFaviconUrl(rootDomain) });
  return NextResponse.json({ rootDomain });
}

const SenderIdentitySchema = z.object({
  senderName: z.string().trim().max(120).optional(),
  fromLocalPart: z
    .string()
    .trim()
    .max(64)
    .refine((s) => s === "" || /^[^@\s]+$/.test(s), { message: "invalid local part" })
    .optional(),
  fromDomain: z.string().trim().max(253).optional(),
  replyTo: z
    .string()
    .trim()
    .max(254)
    .refine((s) => s === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), {
      message: "enter a valid email address",
    })
    .optional(),
  privacyPolicyUrl: z
    .string()
    .trim()
    .max(2048)
    // Reject whitespace and HTML-attribute-breakout chars — this URL is rendered
    // into the footer's href (defence in depth alongside escaping at render time).
    .refine((s) => s === "" || /^https?:\/\/[^\s"'<>\\]+$/i.test(s), {
      message: "enter a valid http(s) URL",
    })
    .optional(),
});

/** Save the global sender identity (name / from / reply-to). Domains unchanged. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = SenderIdentitySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const existing = await getSenderConfig(ctx.tenantId);
  // Omitted → keep existing; empty string → clear.
  const keep = (next: string | undefined, prev: string | undefined) =>
    next === undefined ? prev : next || undefined;
  const privacyPolicyUrl = keep(parsed.data.privacyPolicyUrl, existing.privacyPolicyUrl);
  // Privacy Policy URL is mandatory: reject a save that would leave it unset
  // (either newly provided or already stored). The footer always renders it.
  if (!privacyPolicyUrl) {
    return NextResponse.json({ error: "privacy_policy_required" }, { status: 400 });
  }
  const config: EmailSenderConfig = {
    ...existing,
    senderName: keep(parsed.data.senderName, existing.senderName),
    fromLocalPart: keep(parsed.data.fromLocalPart, existing.fromLocalPart),
    fromDomain: keep(parsed.data.fromDomain, existing.fromDomain),
    replyTo: keep(parsed.data.replyTo, existing.replyTo),
    privacyPolicyUrl,
  };
  await saveSenderConfig(ctx.tenantId, config);
  return NextResponse.json(present(config));
}

const AddDomainSchema = z.object({ domain: z.string() });

/** Add a sending domain: register with Mandrill + seed its DNS records/status. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = AddDomainSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const domain = normalizeDomain(parsed.data.domain);
  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
  }

  const config = await getSenderConfig(ctx.tenantId);
  if (config.domains.some((d) => d.domain === domain)) {
    return NextResponse.json(present(config)); // idempotent
  }

  const now = new Date().toISOString();
  let dkimValid = false;
  let spfValid = false;
  let ownershipValid = false;
  let verifyTxtKey: string | undefined;
  let status: SenderDomain["status"] = "pending";
  let detail: string | undefined;
  if (mandrillConfigured()) {
    const added = await addSendingDomain(domain); // register + mint ownership token (idempotent provider-side)
    const checked = await checkSendingDomain(domain);
    dkimValid = checked.dkimValid;
    spfValid = checked.spfValid;
    ownershipValid = checked.ownershipValid;
    verifyTxtKey = checked.verifyTxtKey ?? added.verifyTxtKey;
    status = checked.status;
    detail = checked.detail;
  }

  const entry: SenderDomain = {
    domain,
    status,
    dkimValid,
    spfValid,
    records: applyRecordValidity(senderDnsRecords(domain, verifyTxtKey), {
      dkimValid,
      spfValid,
      ownershipValid,
    }),
    addedAt: now,
    ...(verifyTxtKey ? { verifyTxtKey } : {}),
    ...(mandrillConfigured() ? { lastCheckedAt: now } : {}),
    ...(detail ? { detail } : {}),
  };

  // Atomic append: re-check for the domain in the FRESH config so a concurrent
  // verify/add tick can't be clobbered by a stale full-array overwrite.
  const next = await mutateSenderConfig(ctx.tenantId, (cur) =>
    cur.domains.some((d) => d.domain === domain)
      ? cur // added concurrently — idempotent
      : { ...cur, domains: [...cur.domains, entry] },
  );
  return NextResponse.json(present(next));
}

const RemoveDomainSchema = z.object({ domain: z.string() });

/** Remove a sending domain from the tenant config. */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = RemoveDomainSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const domain = normalizeDomain(parsed.data.domain);

  const config = await getSenderConfig(ctx.tenantId);
  const next: EmailSenderConfig = {
    ...config,
    domains: config.domains.filter((d) => d.domain !== domain),
  };
  await saveSenderConfig(ctx.tenantId, next);
  return NextResponse.json(present(next));
}
