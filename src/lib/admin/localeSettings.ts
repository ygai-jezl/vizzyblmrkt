import { z } from "zod";
import { SUPPORTED_LOCALES, isSupportedLocale } from "@/lib/i18n/locale";
import { MAX_MIN_READERS } from "@/lib/i18n/readerRules";
import { isHttpsUrl } from "@/lib/types/brandMap";

/**
 * Strict validation for the tenant-level locale form (Account Settings → Settings
 * → Languages). Both fields must be supported base codes, and the default must be
 * one of the supported languages. Mirrors the per-launch locale block in
 * StrategySettingsSchema (src/lib/admin/campaignSettings.ts). CONTENT language
 * only — never coupled to the tenant's immutable data-residency `region`.
 */
export const LocaleSettingsSchema = z
  .object({
    defaultLocale: z
      .string()
      .trim()
      .refine(isSupportedLocale, { message: "unsupported language" }),
    supportedLocales: z
      .array(z.string().trim())
      .max(SUPPORTED_LOCALES.length)
      .refine((arr) => arr.every(isSupportedLocale), {
        message: "supportedLocales contains an unsupported language",
      }),
    /** Readers a language needs for its own version (LANGUAGE_READERS_ENABLED); admins only. */
    minReaders: z.number().int().min(1).max(MAX_MIN_READERS).optional(),
    /** A site folder per language (PAGE_LANGUAGES_ENABLED); admins only. Empty means none. */
    siteAddresses: z
      .record(z.string().max(10), z.string().trim().max(300))
      .refine((m) => Object.keys(m).length <= SUPPORTED_LOCALES.length)
      .refine((m) => Object.values(m).every((u) => u === "" || isHttpsUrl(u)), { message: "each address must be https" })
      .optional(),
    /** The "Translated from … and checked by our team." line on translated articles; admins only. */
    translatedNote: z.boolean().optional(),
  })
  .refine((s) => s.supportedLocales.includes(s.defaultLocale), {
    message: "the default language must be one of the supported languages",
    path: ["supportedLocales"],
  });

export type LocaleSettings = z.infer<typeof LocaleSettingsSchema>;
