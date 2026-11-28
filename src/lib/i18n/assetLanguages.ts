import { versionReadiness } from "./readerRules";

/**
 * Which other languages a piece gets its own version in (ASSET_TRANSLATIONS_ENABLED). Pure: the
 * caller passes the brand's list, its threshold and the readers per language (languageReaders).
 *
 * Piece 2 knows one kind, journey emails, whose readers are the brand's audience: each language in
 * the list other than the email's base, with at least `minReaders` readers. Articles (by site
 * address) and posts (by account language) come with their own pieces.
 */

export type AssetKind = "journey_email" | "article";

export interface LanguagePlan {
  base: string;
  /** Languages that get a version, each with its readers. */
  extras: Array<{ code: string; readers: number }>;
  /** Languages in the list that don't yet, with how many more readers each needs. */
  skipped: Array<{ code: string; readers: number; more: number }>;
}

export function languagesFor(args: {
  kind: AssetKind;
  base: string;
  /** The brand's one list, default first (brandLanguages). */
  list: readonly string[];
  minReaders: number;
  /** Readers per language, or null when the brand has one language and nothing was counted. */
  readers: Record<string, number> | null;
}): LanguagePlan {
  const plan: LanguagePlan = { base: args.base, extras: [], skipped: [] };
  // One language: nothing to make and nothing to read.
  if (args.list.length < 2 || !args.readers) return plan;
  for (const code of args.list) {
    if (code === args.base) continue;
    const readers = args.readers[code] ?? 0;
    const { ready, more } = versionReadiness(readers, args.minReaders);
    if (ready) plan.extras.push({ code, readers });
    else plan.skipped.push({ code, readers, more });
  }
  return plan;
}

/**
 * An article's languages (PAGE_LANGUAGES_ENABLED). The plan's own choice from Create when it made
 * one (`chosen`, `[]` for none). Otherwise each language with enough readers and a site folder: a
 * version needs an address on the brand's site. `extra` adds a language a person asked for (Make
 * anyway). Pure.
 */
export function articleLanguages(args: {
  base: string;
  list: readonly string[];
  minReaders: number;
  readers: Record<string, number> | null;
  sites: Record<string, string>;
  chosen?: readonly string[] | null;
  extra?: readonly string[];
}): string[] {
  const others = args.list.filter((c) => c !== args.base);
  const wanted = args.chosen
    ? others.filter((c) => args.chosen!.includes(c))
    : args.readers && args.list.length > 1
      ? others.filter((c) => Boolean(args.sites[c]) && versionReadiness(args.readers![c] ?? 0, args.minReaders).ready)
      : [];
  return [...new Set([...wanted, ...(args.extra ?? []).filter((c) => others.includes(c))])];
}
