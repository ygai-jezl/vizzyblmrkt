import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById, updateTenantConfig } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SettingsSchema = z.object({
  requiresOwnApiKey: z.boolean(),
  // Omitted → keep existing; empty string → clear. Never echoed back.
  apiKey: z.string().optional(),
  audienceId: z.string().optional(),
  serverPrefix: z.string().optional(),
});

/** Read the tenant's MailChimp config (the key itself is never returned). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  const cfg = tenant?.mailchimpConfig;
  return NextResponse.json({
    requiresOwnApiKey: cfg?.requiresOwnApiKey ?? false,
    apiKeySet: Boolean(cfg?.apiKey),
    audienceId: cfg?.audienceId ?? null,
    serverPrefix: cfg?.serverPrefix ?? null,
  });
}

/** Update the BYO feature gate + (optionally) the tenant's own credentials. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = SettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const tenant = await getTenantById(ctx.tenantId);
  if (!tenant) {
    return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
  }
  const existing = tenant.mailchimpConfig;

  const next = {
    requiresOwnApiKey: parsed.data.requiresOwnApiKey,
    apiKey:
      parsed.data.apiKey === undefined
        ? existing?.apiKey
        : parsed.data.apiKey || undefined,
    audienceId: parsed.data.audienceId ?? existing?.audienceId,
    serverPrefix: parsed.data.serverPrefix ?? existing?.serverPrefix,
  };

  await updateTenantConfig(ctx.tenantId, { mailchimpConfig: next });
  return NextResponse.json({ ok: true, requiresOwnApiKey: next.requiresOwnApiKey });
}
