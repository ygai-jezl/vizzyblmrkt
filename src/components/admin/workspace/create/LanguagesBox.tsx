"use client";

import { useEffect, useState } from "react";
import { languageName } from "@/lib/i18n/locale";
import { versionReadiness } from "@/lib/i18n/readerRules";

/**
 * Create, Topology step (PAGE_LANGUAGES_ENABLED): which other languages a blog article gets. Shown
 * only for a brand with two languages or more. Ready languages with a site folder are ticked; the
 * others say why not, and can be ticked anyway. The choice is saved on the plan as
 * `topology.languages`, and the versions are made once the article is approved.
 */

interface LocaleView {
  defaultLocale: string;
  supportedLocales: string[];
  minReaders?: number;
  readers?: Record<string, number> | null;
  siteAddresses?: Record<string, string>;
}

/** The brand's languages and readers; null until loaded, or for a brand with one language. */
export function useBrandLanguages(enabled: boolean): LocaleView | null {
  const [view, setView] = useState<LocaleView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetch("/api/admin/account/locale?readers=1")
      .then((r) => (r.ok ? (r.json() as Promise<LocaleView>) : null))
      .then((v) => {
        if (live && v && v.supportedLocales.length > 1) setView(v);
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? view : null;
}

/** The languages ticked by default: enough readers and a site folder. */
export function defaultArticleLanguages(view: LocaleView): string[] {
  const min = view.minReaders ?? 10;
  return view.supportedLocales.filter((c) => c !== view.defaultLocale && view.siteAddresses?.[c] && versionReadiness(view.readers?.[c] ?? 0, min).ready);
}

export function LanguagesBox({ view, chosen, onChange }: { view: LocaleView; chosen: string[]; onChange: (next: string[]) => void }) {
  const base = languageName(view.defaultLocale);
  const min = view.minReaders ?? 10;
  const others = view.supportedLocales.filter((c) => c !== view.defaultLocale);
  const toggle = (code: string) => onChange(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);
  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-sm font-medium">Languages</p>
      <p className="text-xs text-neutral-500">
        Written in {base} first. Each language is made after you approve the {base} article.
      </p>
      <ul className="space-y-1.5">
        {others.map((code) => {
          const readers = view.readers?.[code] ?? 0;
          const folder = view.siteAddresses?.[code] ?? null;
          const { ready } = versionReadiness(readers, min);
          const why = !ready
            ? `${readers.toLocaleString()} readers, under your ${min}. They get ${base}. Tick to make it anyway.`
            : folder
              ? `For the article at ${folder}. ${readers.toLocaleString()} readers.`
              : `${readers.toLocaleString()} readers. Add its folder in Settings, so the version has an address.`;
          return (
            <li key={code}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={chosen.includes(code)} onChange={() => toggle(code)} />
                <span>
                  {languageName(code)}
                  <span className="block text-xs text-neutral-500">{why}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        {chosen.length === 0 ? "No translations" : chosen.length === 1 ? "Adds 1 translation" : `Adds ${chosen.length} translations`}
      </p>
    </div>
  );
}
