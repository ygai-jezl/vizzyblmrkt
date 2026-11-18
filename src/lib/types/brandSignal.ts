import { z } from "zod";

/**
 * Outside numbers about a brand (BRAND_SIGNALS_ENABLED), one record per thing measured, in
 * `brand_signals` (the brand's regional database). Today: Google's results for one question in one
 * market, looked up through DataForSEO (SIGNALS_DATAFORSEO_ENABLED). Search Console and GA4 join
 * later. Public search results only: no end user's data.
 *
 * The id comes from the brand, the question's words and the market, so looking the same question
 * up again overwrites the same record: the store never grows past one record per question and
 * market. A record is its own queue item: `posted` (DataForSEO has the task), then `ready` or
 * `failed`, collected under a lease so two runs never collect the same task.
 */

export type SignalStatus = "posted" | "ready" | "failed";

export interface SignalMarket {
  /** ISO 3166-1 alpha-2, upper case ("US", "GB"). */
  country: string;
  /** Google's interface language ("en", "de"). */
  language: string;
}

export interface SerpResult {
  position: number;
  domain: string;
  url: string;
  title: string;
}

export interface SerpAsk {
  question: string;
  url: string | null;
  domain: string | null;
}

export interface SerpCite {
  domain: string;
  url: string;
  title: string;
}

/** What Google showed, as we keep it: short, and only what planning reads. */
export interface SerpFindings {
  /** The top organic results (at most 10). */
  top: SerpResult[];
  /** People also ask, in the order Google showed them. */
  paa: SerpAsk[];
  /** "People also search for". */
  alsoSearched: string[];
  /** Related searches at the foot of the page. */
  related: string[];
  /** Google's AI Overview, when it showed one: the pages it cited. */
  aiOverview: { cites: SerpCite[] } | null;
}

/** The numbers, each with a meaning in src/lib/metrics/meanings.ts. */
export interface SerpNumbers {
  /** Where the brand's own page ranks (1 is top), or null when it isn't in the top results. */
  googlePosition: number | null;
  /** How many People also ask questions Google showed. */
  peopleAlsoAsk: number;
  /** How many pages Google's AI Overview cited (0 when there was none). */
  aiOverviewSources: number;
  /** Whether the AI Overview cited the brand's own site. Null when there was no AI Overview. */
  aiOverviewCitesYou: boolean | null;
}

/** What the judge (src/lib/signals/judge.ts) made of one thing Google showed. */
export type FoundVerdict = "use" | "other" | "drop";

export interface JudgedItem {
  text: string;
  /** A People also ask question, a "people also search for" phrase, or a question a competitor article answers. */
  kind: "paa" | "also" | "theirs";
  /** use: fits this question's article. other: fits another article. drop: off topic or a repeat. */
  verdict: FoundVerdict;
  reason: string;
  /** For "other": the subject it fits, a name on the brand map or a new one. */
  subject?: string | null;
}

/** The judge's verdicts, kept with the lookup so it never judges the same results twice. */
export interface SerpJudgement {
  at: string;
  version: number;
  items: JudgedItem[];
}

export interface BrandSignal {
  id: string;
  tenantId: string;
  source: "dataforseo";
  /** What was looked up: the words searched, and the map question they came from when known. */
  about: { query: string; questionId: string | null; subjectId: string | null };
  market: SignalMarket;
  status: SignalStatus;
  /** DataForSEO's task id. */
  taskId: string | null;
  /** Who asked: a person waiting (looked up first), or scheduled work. */
  askedBy: "person" | "schedule";
  postedAt: string;
  /** Not collected before this. */
  dueAt: string;
  readyAt: string | null;
  /** "2026-11": the month the lookup counts against the brand's cap. */
  lookupMonth: string;
  /** What DataForSEO charged, in US dollars, when it said. */
  cost: number | null;
  numbers: SerpNumbers | null;
  results: SerpFindings | null;
  /** Why it failed, as a short code ("timeout", "dataforseo_40501"). Never a credential. */
  error: string | null;
  /** What fits the question, judged once the results are in (absent until then). */
  judged?: SerpJudgement | null;
  attempts: number;
  leaseId: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A brand's Google market for lookups (tenant.searchMarket). */
export const SearchMarketSchema = z.object({
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase()),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
});
export type SearchMarket = z.infer<typeof SearchMarketSchema>;
