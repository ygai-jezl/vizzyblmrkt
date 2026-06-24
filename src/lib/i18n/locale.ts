/**
 * Multilingual content support — the SINGLE source of truth for the content
 * languages a launch can be authored/served in, and for how we steer the Gemini
 * agents to respond in them.
 *
 * A `locale` here is CONTENT language only. It is strictly decoupled from a
 * tenant's `region` (data residency), which is immutable and selects the
 * physical Firestore database + the cross-border PII gate. Never derive, mutate,
 * or substitute `region` from a locale — that would silently breach residency.
 *
 * Gemini Flash text has NO response-language config field (per Google docs), so
 * language is steered purely via the system instruction: `languageDirective()`
 * returns the sentence the agents inject. There is nothing to set on the request
 * itself. The Gemini Live voice API supports a smaller set — `liveCode` marks the
 * locales it covers, so the voice chat can be gated to them (Phase 4).
 */

export interface LocaleInfo {
  /** Base language subtag we steer the model on (e.g. "fr"). */
  code: string;
  /** English name, interpolated into the prompt directive (e.g. "French"). */
  name: string;
  /** Endonym, for a future in-widget language switcher (e.g. "Français"). */
  nativeName: string;
  /** Writing direction — drives <html dir> / email dir (Phase 5). */
  dir: "ltr" | "rtl";
  /**
   * BCP-47 code to hand the Gemini Live API as a transcription/voice hint
   * (Phase 4). Absent ⇒ the language is NOT in the Live voice set, so the
   * post-signup voice chat should be disabled for it.
   */
  liveCode?: string;
}

/**
 * Curated content-language set. Text generation supports ~100+ languages; this
 * is the admin-selectable subset. `liveCode` marks the languages the Gemini Live
 * voice chat supports (drawn from the 24 BCP-47 codes in Google's docs); 23 of
 * the rows below carry one — `zh` is text-only. Used to gate the voice chat.
 */
export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", name: "English", nativeName: "English", dir: "ltr", liveCode: "en-US" },
  { code: "es", name: "Spanish", nativeName: "Español", dir: "ltr", liveCode: "es-US" },
  { code: "fr", name: "French", nativeName: "Français", dir: "ltr", liveCode: "fr-FR" },
  { code: "de", name: "German", nativeName: "Deutsch", dir: "ltr", liveCode: "de-DE" },
  { code: "it", name: "Italian", nativeName: "Italiano", dir: "ltr", liveCode: "it-IT" },
  { code: "pt", name: "Portuguese", nativeName: "Português", dir: "ltr", liveCode: "pt-BR" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", dir: "ltr", liveCode: "nl-NL" },
  { code: "pl", name: "Polish", nativeName: "Polski", dir: "ltr", liveCode: "pl-PL" },
  { code: "ro", name: "Romanian", nativeName: "Română", dir: "ltr", liveCode: "ro-RO" },
  { code: "ru", name: "Russian", nativeName: "Русский", dir: "ltr", liveCode: "ru-RU" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", dir: "ltr", liveCode: "uk-UA" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", dir: "ltr", liveCode: "tr-TR" },
  { code: "ar", name: "Arabic", nativeName: "العربية", dir: "rtl", liveCode: "ar-EG" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", dir: "ltr", liveCode: "hi-IN" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", dir: "ltr", liveCode: "bn-BD" },
  { code: "mr", name: "Marathi", nativeName: "मराठी", dir: "ltr", liveCode: "mr-IN" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்", dir: "ltr", liveCode: "ta-IN" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు", dir: "ltr", liveCode: "te-IN" },
  { code: "th", name: "Thai", nativeName: "ไทย", dir: "ltr", liveCode: "th-TH" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", dir: "ltr", liveCode: "vi-VN" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", dir: "ltr", liveCode: "id-ID" },
  { code: "ja", name: "Japanese", nativeName: "日本語", dir: "ltr", liveCode: "ja-JP" },
  { code: "ko", name: "Korean", nativeName: "한국어", dir: "ltr", liveCode: "ko-KR" },
  // Text only — not in the Live voice set (no `liveCode`).
  { code: "zh", name: "Chinese (Simplified)", nativeName: "简体中文", dir: "ltr" },
];

export const DEFAULT_LOCALE = "en";

const BY_CODE: Record<string, LocaleInfo> = Object.fromEntries(
  LOCALES.map((l) => [l.code, l]),
);

/** All admin-selectable base codes, in display order. */
export const SUPPORTED_LOCALES: readonly string[] = LOCALES.map((l) => l.code);

export function isSupportedLocale(code: string | null | undefined): boolean {
  return code != null && code in BY_CODE;
}

/**
 * Coerce a raw BCP-47 / region-tagged string ("fr-FR", "PT_br", "EN") down to a
 * supported base code, or null if unsupported. Tolerant of case and separators.
 */
export function normalizeLocale(input: string | null | undefined): string | null {
  if (!input) return null;
  const base = input.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
  return base && base in BY_CODE ? base : null;
}

/** Full info for a code (falls back to English for an unknown/unset code). */
export function localeInfo(code: string | null | undefined): LocaleInfo {
  const norm = normalizeLocale(code);
  return (norm && BY_CODE[norm]) || BY_CODE[DEFAULT_LOCALE]!;
}

/** English name for the prompt directive (falls back to English). */
export function languageName(code: string | null | undefined): string {
  return localeInfo(code).name;
}

/** True when the locale is in the Gemini Live voice set (has a `liveCode`). */
export function isLiveSupportedLocale(code: string | null | undefined): boolean {
  return !!localeInfo(code).liveCode;
}

/** BCP-47 code to hint the Gemini Live transcription/voice with, or undefined. */
export function liveCodeFor(code: string | null | undefined): string | undefined {
  return localeInfo(code).liveCode;
}

/**
 * The system-instruction sentence that steers a Gemini text/voice agent to
 * answer in `code`. Returns "" for English (or an unknown code) so English-only
 * prompts are byte-for-byte unchanged. The directive explicitly PRESERVES the
 * {{merge_token}} vocabulary and HTML tags so localized copy keeps them verbatim.
 */
export function languageDirective(code: string | null | undefined): string {
  const norm = normalizeLocale(code);
  if (!norm || norm === DEFAULT_LOCALE) return "";
  const name = BY_CODE[norm]!.name;
  return (
    `RESPOND ONLY IN ${name}. Every word of your reply — including the subject line ` +
    `and any call to action — MUST be written in ${name}. Translate ONLY the human-readable ` +
    `text values: do NOT translate, rename, or remove any {{double_brace}} merge tokens, HTML ` +
    `tags, or JSON field names/keys — reproduce those exactly as given (in English).`
  );
}

/**
 * Resolve the content locale for a launch's AGENT-GENERATED output: the launch's
 * pinned default, else the tenant default, else English. (This is the launch
 * default; per-visitor resolution is `resolveVisitorLocale` below.)
 */
export function resolveCampaignLocale(
  campaign?: { strategy?: { defaultLocale?: string | null } | null } | null,
  tenant?: { defaultLocale?: string | null } | null,
): string {
  return (
    normalizeLocale(campaign?.strategy?.defaultLocale) ??
    normalizeLocale(tenant?.defaultLocale) ??
    DEFAULT_LOCALE
  );
}

type LocaleConfig =
  | {
      strategy?: { defaultLocale?: string | null; supportedLocales?: string[] | null } | null;
    }
  | null
  | undefined;
type TenantLocaleConfig =
  | { defaultLocale?: string | null; supportedLocales?: string[] | null }
  | null
  | undefined;

/**
 * The languages a launch is offered in: the admin-defined `supportedLocales`
 * (campaign over tenant), always including the resolved default, normalised and
 * deduped. Falls back to just the default. Used to clamp per-visitor resolution.
 */
export function supportedLocalesFor(campaign?: LocaleConfig, tenant?: TenantLocaleConfig): string[] {
  const def = resolveCampaignLocale(campaign, tenant);
  const fromCampaign = (campaign?.strategy?.supportedLocales ?? [])
    .map(normalizeLocale)
    .filter((c): c is string => !!c);
  const fromTenant = (tenant?.supportedLocales ?? [])
    .map(normalizeLocale)
    .filter((c): c is string => !!c);
  const declared = fromCampaign.length ? fromCampaign : fromTenant;
  return Array.from(new Set([def, ...declared]));
}

/**
 * Parse an Accept-Language header and return the highest-q-weighted base code
 * that is in `supported`, or null. Tolerant of malformed q-values.
 */
function negotiateAcceptLanguage(header: string | null | undefined, supported: string[]): string | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=")[1] ?? "") : 1;
      return { code: normalizeLocale(tag), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((x): x is { code: string; q: number } => !!x.code && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { code } of ranked) {
    if (supported.includes(code)) return code;
  }
  return null;
}

/**
 * Per-VISITOR content locale, negotiated against the launch's `supportedLocales`.
 * First match wins: explicit choice (switcher/?lng=/cookie) → the locale saved on
 * a returning signup → the browser's Accept-Language → the launch default. The
 * result is always one of `supportedLocalesFor(campaign, tenant)`. Resolve this
 * SERVER-SIDE (in the page component) so SSR and hydration agree.
 */
export function resolveVisitorLocale(inputs: {
  explicit?: string | null;
  savedLocale?: string | null;
  acceptLanguage?: string | null;
  campaign?: LocaleConfig;
  tenant?: TenantLocaleConfig;
}): string {
  const supported = supportedLocalesFor(inputs.campaign, inputs.tenant);
  const inSet = (code: string | null): code is string => !!code && supported.includes(code);

  const explicit = normalizeLocale(inputs.explicit);
  if (inSet(explicit)) return explicit;
  const saved = normalizeLocale(inputs.savedLocale);
  if (inSet(saved)) return saved;
  const fromHeader = negotiateAcceptLanguage(inputs.acceptLanguage, supported);
  if (fromHeader) return fromHeader;
  return resolveCampaignLocale(inputs.campaign, inputs.tenant);
}
