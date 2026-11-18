import type { SignalMarket } from "@/lib/types/brandSignal";

/**
 * The Google markets a brand can look questions up in (tenant.searchMarket), with DataForSEO's
 * location code for each. Codes are DataForSEO's Google SERP locations (2000 + the country's ISO
 * numeric code), as listed by /v3/serp/google/locations. A short list on purpose: the markets a
 * brand is likely to sell in. Add a row to add a market.
 */
export interface Market {
  country: string;
  name: string;
  locationCode: number;
  /** The usual language, picked first. */
  language: string;
}

export const MARKETS: readonly Market[] = [
  { country: "US", name: "United States", locationCode: 2840, language: "en" },
  { country: "GB", name: "United Kingdom", locationCode: 2826, language: "en" },
  { country: "IE", name: "Ireland", locationCode: 2372, language: "en" },
  { country: "CA", name: "Canada", locationCode: 2124, language: "en" },
  { country: "AU", name: "Australia", locationCode: 2036, language: "en" },
  { country: "NZ", name: "New Zealand", locationCode: 2554, language: "en" },
  { country: "ZA", name: "South Africa", locationCode: 2710, language: "en" },
  { country: "IN", name: "India", locationCode: 2356, language: "en" },
  { country: "SG", name: "Singapore", locationCode: 2702, language: "en" },
  { country: "HK", name: "Hong Kong", locationCode: 2344, language: "en" },
  { country: "DE", name: "Germany", locationCode: 2276, language: "de" },
  { country: "AT", name: "Austria", locationCode: 2040, language: "de" },
  { country: "CH", name: "Switzerland", locationCode: 2756, language: "de" },
  { country: "FR", name: "France", locationCode: 2250, language: "fr" },
  { country: "BE", name: "Belgium", locationCode: 2056, language: "fr" },
  { country: "NL", name: "Netherlands", locationCode: 2528, language: "nl" },
  { country: "ES", name: "Spain", locationCode: 2724, language: "es" },
  { country: "MX", name: "Mexico", locationCode: 2484, language: "es" },
  { country: "IT", name: "Italy", locationCode: 2380, language: "it" },
  { country: "PT", name: "Portugal", locationCode: 2620, language: "pt" },
  { country: "BR", name: "Brazil", locationCode: 2076, language: "pt" },
  { country: "SE", name: "Sweden", locationCode: 2752, language: "sv" },
  { country: "NO", name: "Norway", locationCode: 2578, language: "nb" },
  { country: "DK", name: "Denmark", locationCode: 2208, language: "da" },
  { country: "FI", name: "Finland", locationCode: 2246, language: "fi" },
  { country: "PL", name: "Poland", locationCode: 2616, language: "pl" },
  { country: "JP", name: "Japan", locationCode: 2392, language: "ja" },
  { country: "KR", name: "South Korea", locationCode: 2410, language: "ko" },
];

/** Google interface languages a brand can choose, by code. */
export const LANGUAGES: Readonly<Record<string, string>> = {
  en: "English",
  de: "German",
  fr: "French",
  nl: "Dutch",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  sv: "Swedish",
  nb: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  pl: "Polish",
  ja: "Japanese",
  ko: "Korean",
};

/** Where a brand looks things up when it hasn't chosen. */
export const DEFAULT_MARKET: SignalMarket = { country: "US", language: "en" };

export function marketOf(country: string): Market | null {
  return MARKETS.find((m) => m.country === country.toUpperCase()) ?? null;
}

/** Whether a market is one we can look up in. */
export function isKnownMarket(m: SignalMarket): boolean {
  return Boolean(marketOf(m.country)) && m.language in LANGUAGES;
}

/** The brand's market, or the default when it has none (or one we no longer list). */
export function brandMarket(saved: SignalMarket | null | undefined): SignalMarket {
  return saved && isKnownMarket(saved) ? { country: saved.country.toUpperCase(), language: saved.language } : DEFAULT_MARKET;
}

/** "Google United Kingdom, English": how the market reads on a screen. */
export function marketLabel(m: SignalMarket): string {
  const name = marketOf(m.country)?.name ?? m.country;
  return `Google ${name}, ${LANGUAGES[m.language] ?? m.language}`;
}
