import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { DEFAULT_LOCALE, normalizeLocale } from "@/lib/i18n/locale";
import { LocaleSettingsSchema } from "@/lib/admin/localeSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tenant-level CONTENT language defaults (Account Settings → Settings → Languages):
 * the fallback `defaultLocale` and the `supportedLocales` allow-list used by any
 * launch that doesn't pin its own. CONTENT language only — strictly decoupled from
 * the tenant's immutable data-residency `region` (never derive region from locale).
 */
async function requireCtx() {
  return (await getAdminContext()) ?? null;
}

/** Normalised, default-included view of the tenant's locale config. */
function present(tenant: { defaultLocale?: string | null; supportedLocales?: string[] | null } | null) {
  const defaultLocale = normalizeLocale(tenant?.defaultLocale) ?? DEFAULT_LOCALE;
  const extra = (tenant?.supportedLocales ?? [])
    .map((c) => normalizeLocale(c))
    .filter((c): c is string => !!c);
  return { defaultLocale, supportedLocales: Array.from(new Set([defaultLocale, ...extra])) };
}

/** Read the tenant's default + supported content languages. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  return NextResponse.json(present(tenant));
}

/** Save the tenant's default + supported content languages. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = LocaleSettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  // Guarantee the default is present + first; dedupe. (The refine already ensures
  // it's included; this also normalises order so the picker round-trips cleanly.)
  const { defaultLocale } = parsed.data;
  const supportedLocales = Array.from(new Set([defaultLocale, ...parsed.data.supportedLocales]));
  await updateTenantConfig(ctx.tenantId, { defaultLocale, supportedLocales });
  return NextResponse.json({ defaultLocale, supportedLocales });
}
