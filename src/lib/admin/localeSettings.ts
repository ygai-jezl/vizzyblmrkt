import { z } from "zod";
import { SUPPORTED_LOCALES, isSupportedLocale } from "@/lib/i18n/locale";

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
  })
  .refine((s) => s.supportedLocales.includes(s.defaultLocale), {
    message: "the default language must be one of the supported languages",
    path: ["supportedLocales"],
  });

export type LocaleSettings = z.infer<typeof LocaleSettingsSchema>;
