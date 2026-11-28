import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { DEFAULT_LOCALE, normalizeLocale } from "@/lib/i18n/locale";
import { LocaleSettingsSchema } from "@/lib/admin/localeSettings";
import { isContentLanguageEnabled, isLanguageReadersEnabled, isAssetTranslationsEnabled, isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { cleanSiteAddresses, sameAddresses } from "@/lib/i18n/siteAddresses";
import { brandLanguages, languageReaders, minReadersOf } from "@/lib/i18n/languageReaders";

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
  return { defaultLocale, supportedLocales: brandLanguages({ defaultLocale, supportedLocales: tenant?.supportedLocales ?? undefined }) };
}

/**
 * Read the tenant's default + supported content languages. With LANGUAGE_READERS_ENABLED it also
 * says launches use this one list (`oneList`), the threshold (`minReaders`) and whether this person
 * may change it (`canSetMinReaders`, admins). `?readers=1` adds the readers per language (null for
 * one language, or when they couldn't be counted), counted at most once a day.
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await requireCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  // `writesEverything`: the default is the language YouGrow writes everything in (CONTENT_LANGUAGE_ENABLED).
  const base = { ...present(tenant), writesEverything: isContentLanguageEnabled() };
  if (!isLanguageReadersEnabled()) return NextResponse.json(base);
  const wantReaders = new URL(req.url).searchParams.get("readers") === "1";
  const counted = wantReaders ? await languageReaders(ctx, tenant) : null;
  return NextResponse.json({
    ...base,
    oneList: true,
    minReaders: minReadersOf(tenant),
    canSetMinReaders: ctx.role === "admin",
    // Journey emails are translated for languages over the threshold (ASSET_TRANSLATIONS_ENABLED).
    ...(isAssetTranslationsEnabled() ? { translations: true } : {}),
    // Where each language goes on the brand's site, and the translated note (PAGE_LANGUAGES_ENABLED).
    ...(isPageLanguagesEnabled()
      ? {
          pages: true,
          siteAddresses: cleanSiteAddresses(tenant?.languageSettings?.siteAddresses, base.supportedLocales, base.defaultLocale),
          translatedNote: tenant?.languageSettings?.translatedNote === true,
        }
      : {}),
    ...(wantReaders ? { readers: counted?.readers ?? null } : {}),
  });
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

  // The threshold (LANGUAGE_READERS_ENABLED): only an admin changes it. Sending the number it
  // already has, as a member's Save does, is fine. Ignored while the switch is off.
  if (!isLanguageReadersEnabled()) {
    await updateTenantConfig(ctx.tenantId, { defaultLocale, supportedLocales });
    return NextResponse.json({ defaultLocale, supportedLocales });
  }
  const tenant = await getTenantById(ctx.tenantId);
  const minReaders = parsed.data.minReaders ?? minReadersOf(tenant);
  const changed = minReaders !== minReadersOf(tenant);
  // Where each language goes and the translated note (PAGE_LANGUAGES_ENABLED): only an admin changes
  // them. A language taken off the list loses its folder, whoever saves.
  const pages = isPageLanguagesEnabled();
  const stored = tenant?.languageSettings?.siteAddresses ?? {};
  const kept = cleanSiteAddresses(stored, supportedLocales, defaultLocale);
  const asked = pages && parsed.data.siteAddresses !== undefined ? cleanSiteAddresses(parsed.data.siteAddresses, supportedLocales, defaultLocale) : kept;
  const sitesChanged = pages && !sameAddresses(asked, kept);
  const note = pages && parsed.data.translatedNote !== undefined ? parsed.data.translatedNote : tenant?.languageSettings?.translatedNote === true;
  const noteChanged = pages && note !== (tenant?.languageSettings?.translatedNote === true);
  if ((changed || sitesChanged || noteChanged) && ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const pruned = !sameAddresses(kept, cleanSiteAddresses(stored, Object.keys(stored), defaultLocale));
  const writeSettings = changed || sitesChanged || noteChanged || pruned;
  await updateTenantConfig(ctx.tenantId, {
    defaultLocale,
    supportedLocales,
    ...(writeSettings
      ? {
          languageSettings: {
            ...(tenant?.languageSettings ?? {}),
            ...(changed ? { minReaders } : {}),
            ...(pages || pruned ? { siteAddresses: asked } : {}),
            ...(pages ? { translatedNote: note } : {}),
          },
        }
      : {}),
  });
  return NextResponse.json({ defaultLocale, supportedLocales, minReaders, ...(pages ? { siteAddresses: asked, translatedNote: note } : {}) });
}
