import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  getSenderConfig,
  saveSenderConfig,
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
  return NextResponse.json(present(config));
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
  const config: EmailSenderConfig = {
    ...existing,
    senderName: keep(parsed.data.senderName, existing.senderName),
    fromLocalPart: keep(parsed.data.fromLocalPart, existing.fromLocalPart),
    fromDomain: keep(parsed.data.fromDomain, existing.fromDomain),
    replyTo: keep(parsed.data.replyTo, existing.replyTo),
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
  let status: SenderDomain["status"] = "pending";
  let detail: string | undefined;
  if (mandrillConfigured()) {
    await addSendingDomain(domain); // register (idempotent provider-side)
    const checked = await checkSendingDomain(domain);
    dkimValid = checked.dkimValid;
    spfValid = checked.spfValid;
    status = checked.status;
    detail = checked.detail;
  }

  const entry: SenderDomain = {
    domain,
    status,
    dkimValid,
    spfValid,
    records: applyRecordValidity(senderDnsRecords(domain), { dkimValid, spfValid }),
    addedAt: now,
    ...(mandrillConfigured() ? { lastCheckedAt: now } : {}),
    ...(detail ? { detail } : {}),
  };

  const next: EmailSenderConfig = { ...config, domains: [...config.domains, entry] };
  await saveSenderConfig(ctx.tenantId, next);
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
