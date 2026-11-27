import { forTenant } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { DEFAULT_LOCALE, normalizeLocale } from "./locale";
import { DEFAULT_MIN_READERS } from "./readerRules";

/**
 * Readers per language (LANGUAGE_READERS_ENABLED). A reader is someone in the brand's audience
 * (Everyone on the People list); their language is the one on their person record
 * (src/lib/audience/personSync.ts). Anyone whose language we don't know counts as the default.
 *
 * Counted when asked for and kept on the brand record for a day, so a brand nobody looks at costs
 * nothing: one count() for Everyone and one per other language in the brand's list, each an
 * equality filter that single-field indexes serve. A brand with one language reads nothing.
 */

/** How long a count is kept before it is counted again. */
export const READERS_FRESH_MS = 24 * 60 * 60 * 1000;

export type LanguageReaders = NonNullable<Tenant["languageReaders"]>;

type LanguageConfig = Pick<Tenant, "defaultLocale" | "supportedLocales"> | null | undefined;

/** The brand's one language list: the default first, then the others in the order they were added. */
export function brandLanguages(tenant: LanguageConfig): string[] {
  const def = normalizeLocale(tenant?.defaultLocale) ?? DEFAULT_LOCALE;
  const extra = (tenant?.supportedLocales ?? []).map((c) => normalizeLocale(c)).filter((c): c is string => !!c);
  return [...new Set([def, ...extra])];
}

/** The brand's threshold for a language's own version. */
export function minReadersOf(tenant: Pick<Tenant, "languageSettings"> | null | undefined): number {
  return tenant?.languageSettings?.minReaders ?? DEFAULT_MIN_READERS;
}

/** Readers of each language in the list, the default's being everyone we don't know as another. */
export function readersByLanguage(list: readonly string[], counted: Pick<LanguageReaders, "everyone" | "counts">): Record<string, number> {
  const [def, ...others] = list;
  const out: Record<string, number> = {};
  let known = 0;
  for (const code of others) {
    out[code] = counted.counts[code] ?? 0;
    known += out[code];
  }
  if (def) out[def] = Math.max(0, counted.everyone - known);
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

export interface LanguageReadersDeps {
  db?: FirestoreLike;
  now?: () => number;
}

/**
 * The brand's readers per language, from the day's count or counted now and kept. Null for a brand
 * with one language, or when the count fails (a warning is logged; nothing is kept).
 */
export async function languageReaders(
  ctx: TenantContext,
  tenant: Pick<Tenant, "defaultLocale" | "supportedLocales" | "languageReaders"> | null,
  deps: LanguageReadersDeps = {},
): Promise<{ list: string[]; readers: Record<string, number>; at: string } | null> {
  const list = brandLanguages(tenant);
  if (list.length < 2) return null;
  const nowMs = (deps.now ?? Date.now)();
  const kept = tenant?.languageReaders;
  if (kept && sameList(kept.list, list) && nowMs - Date.parse(kept.at) < READERS_FRESH_MS && Date.parse(kept.at) <= nowMs) {
    return { list, readers: readersByLanguage(list, kept), at: kept.at };
  }
  try {
    const people = forTenant(ctx, deps.db).contacts;
    const [everyone, ...others] = await Promise.all([
      people.count([["memberOf", "array-contains", "all"]]),
      ...list.slice(1).map((code) => people.count([["language", "==", code]])),
    ]);
    const counts = Object.fromEntries(list.slice(1).map((code, i) => [code, others[i] ?? 0]));
    const fresh: LanguageReaders = { at: new Date(nowMs).toISOString(), list, everyone: everyone ?? 0, counts };
    await updateTenantConfig(ctx.tenantId, { languageReaders: fresh }, deps.db).catch((err: unknown) => {
      console.warn(`[languages] keeping the reader count failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    });
    return { list, readers: readersByLanguage(list, fresh), at: fresh.at };
  } catch (err) {
    console.warn(`[languages] counting readers failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
}
