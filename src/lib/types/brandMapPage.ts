import { z } from "zod";

/**
 * A page the brand map knows about (BRAND_MAP_PAGES_ENABLED): an article written here
 * (`p_<planId>`), or a page already on the brand's site (`s_<hash>`). A row holds facts about
 * the page only. Which map question it answers, and what it overlaps, is worked out when the
 * map is read, so editing the map never makes a row stale. Regional collection
 * `brand_map_pages`, reached only through `forTenant(ctx).brandMapPages`.
 */

export const BRAND_MAP_PAGE_LIMITS = {
  title: 200,
  question: 300,
  questions: 10,
  names: 40,
  name: 120,
  links: 100,
  url: 2000,
} as const;
const L = BRAND_MAP_PAGE_LIMITS;

/** Planned (no copy yet), draft (written), approved (a person approved the copy), live (seen at its address). */
export const BrandMapPageState = z.enum(["planned", "draft", "approved", "live"]);
export type BrandMapPageState = z.infer<typeof BrandMapPageState>;

export const BrandMapPageQuestionSchema = z.object({
  text: z.string().max(L.question),
  /** The map question this is, when the brief says so (its id). */
  ref: z.string().max(64).nullable().default(null),
});
export type BrandMapPageQuestion = z.infer<typeof BrandMapPageQuestionSchema>;

export const BrandMapPageFactsSchema = z.object({
  kind: z.enum(["article", "site"]),
  /** An article's plan: where it is opened from. */
  workspaceId: z.string().max(128).nullable().default(null),
  planId: z.string().max(128).nullable().default(null),
  /** The page's address (https), or null while an article has none. */
  url: z.string().max(L.url).nullable().default(null),
  title: z.string().max(L.title).default(""),
  /** The question the page answers first (an article's main question). */
  primaryQuestion: z.string().max(L.question).default(""),
  /** The map question that is, when the article was started from one or research matched it. */
  primaryRef: z.string().max(64).nullable().default(null),
  /** The other questions it answers, one section each. */
  questions: z.array(BrandMapPageQuestionSchema).max(L.questions).default([]),
  /** The map subject an article was written for; null = none chosen. */
  subjectId: z.string().max(64).nullable().default(null),
  /** The names it uses (once written, only those it says). */
  names: z.array(z.string().max(L.name)).max(L.names).default([]),
  /** Its links to the brand's own pages, normalised. */
  links: z.array(z.string().max(L.url)).max(L.links).default([]),
  /** Its links were read (always, for an article; for a page on the site, once it was crawled with them). */
  linksKnown: z.boolean().default(true),
  state: BrandMapPageState.default("planned"),
  /** When it was first seen live (ISO), for "newer" and "older". */
  liveAt: z.string().max(40).nullable().default(null),
});
export type BrandMapPageFacts = z.infer<typeof BrandMapPageFactsSchema>;

export const BrandMapPageSchema = BrandMapPageFactsSchema.extend({
  id: z.string(),
  tenantId: z.string(),
  /** A short hash of the facts, so an unchanged page is never rewritten. */
  fingerprint: z.string().max(64).default(""),
  updatedAt: z.string().max(40).default(""),
});
export type BrandMapPage = z.infer<typeof BrandMapPageSchema>;

/** An article's row id. */
export const planPageId = (planId: string) => `p_${encodeURIComponent(planId)}`;
