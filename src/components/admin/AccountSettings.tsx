"use client";

import { useEffect, useState } from "react";
import { ideaWord } from "@/lib/nav/terms";
import { useWords } from "./nav/WordsProvider";
import {
  LOCALES,
  DEFAULT_LOCALE,
  isLiveSupportedLocale,
  languageName,
  localeInfo,
} from "@/lib/i18n/locale";
import { DEFAULT_MIN_READERS, MAX_MIN_READERS, versionReadiness } from "@/lib/i18n/readerRules";

/**
 * Account Settings → Settings tab. Today it holds the tenant's CONTENT-language
 * defaults (the fallback language + the languages launches are offered in). A
 * launch can override these in its own Strategy settings. Mirrors the per-launch
 * picker in CampaignSettingsForm but binds to TOP-LEVEL tenant fields. CONTENT
 * language only — independent of the tenant's data region.
 */
const LOCALE_OPTIONS = LOCALES.map((l) => ({
  value: l.code,
  label: l.liveCode ? l.name : `${l.name} (text only)`,
}));

interface LocaleConfig {
  defaultLocale: string;
  supportedLocales: string[];
  /** The default is the language YouGrow writes everything in (CONTENT_LANGUAGE_ENABLED). */
  writesEverything?: boolean;
  /** LANGUAGE_READERS_ENABLED: launches use this one list, and readers decide each language's version. */
  oneList?: boolean;
  minReaders?: number;
  canSetMinReaders?: boolean;
  /** Readers per language; null for one language, or when they couldn't be counted. */
  readers?: Record<string, number> | null;
  /** ASSET_TRANSLATIONS_ENABLED: journey emails get a version for languages over the threshold. */
  translations?: boolean;
  /** PAGE_LANGUAGES_ENABLED: each language's folder on the brand's site, and the translated note. */
  pages?: boolean;
  siteAddresses?: Record<string, string>;
  translatedNote?: boolean;
}

export function AccountSettings() {
  const w = ideaWord(useWords().ideas);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultLocale, setDefaultLocale] = useState(DEFAULT_LOCALE);
  const [supportedLocales, setSupportedLocales] = useState<string[]>([DEFAULT_LOCALE]);
  const [writesEverything, setWritesEverything] = useState(false);
  const [oneList, setOneList] = useState(false);
  const [minReaders, setMinReaders] = useState(DEFAULT_MIN_READERS);
  const [canSetMinReaders, setCanSetMinReaders] = useState(false);
  const [readers, setReaders] = useState<Record<string, number> | null>(null);
  const [translations, setTranslations] = useState(false);
  const [pages, setPages] = useState(false);
  const [siteAddresses, setSiteAddresses] = useState<Record<string, string>>({});
  const [translatedNote, setTranslatedNote] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/account/locale?readers=1");
        if (!res.ok) throw new Error("load_failed");
        const data = (await res.json()) as LocaleConfig;
        if (active) {
          setDefaultLocale(data.defaultLocale);
          setSupportedLocales(data.supportedLocales);
          setWritesEverything(data.writesEverything === true);
          setOneList(data.oneList === true);
          setMinReaders(data.minReaders ?? DEFAULT_MIN_READERS);
          setCanSetMinReaders(data.canSetMinReaders === true);
          setReaders(data.readers ?? null);
          setTranslations(data.translations === true);
          setPages(data.pages === true);
          setSiteAddresses(data.siteAddresses ?? {});
          setTranslatedNote(data.translatedNote === true);
        }
      } catch {
        if (active) setLoadError("Couldn't load your language settings.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Default language: changing it keeps any extra languages and re-pins the
  // default first in the supported set.
  function setContentLanguage(code: string) {
    setSupportedLocales((prev) => [code, ...prev.filter((c) => c !== defaultLocale && c !== code)]);
    setDefaultLocale(code);
    setStatus("idle");
  }
  // Additional offered languages; the default is always kept in the set.
  function toggleSupportedLocale(code: string) {
    setSupportedLocales((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      if (!next.includes(defaultLocale)) next.unshift(defaultLocale);
      return next;
    });
    setStatus("idle");
  }

  async function save() {
    setStatus("saving");
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/account/locale", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultLocale, supportedLocales, ...(oneList ? { minReaders } : {}), ...(pages ? { siteAddresses, translatedNote } : {}) }),
      });
      if (!res.ok) throw new Error("save_failed");
      const data = (await res.json()) as LocaleConfig;
      setDefaultLocale(data.defaultLocale);
      setSupportedLocales(data.supportedLocales);
      if (data.minReaders !== undefined) setMinReaders(data.minReaders);
      if (data.siteAddresses) setSiteAddresses(data.siteAddresses);
      // The list may have changed: count again, so the table matches what was saved.
      if (oneList) {
        const fresh = await fetch("/api/admin/account/locale?readers=1").then((r) => (r.ok ? (r.json() as Promise<LocaleConfig>) : null)).catch(() => null);
        setReaders(fresh?.readers ?? null);
      }
      setStatus("saved");
    } catch {
      setStatus("error");
      setSaveError("Couldn't save your language settings.");
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (loadError) {
    return <p className="text-sm text-red-600">{loadError}</p>;
  }

  return (
    <div className="max-w-xl space-y-4">
      <section className="space-y-3 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-base font-semibold">Languages</h2>
          {writesEverything ? (
            <p className="text-sm text-neutral-500">
              The language YouGrow writes everything in for your brand: articles, posts, emails, briefs and
              Vizzy&apos;s suggestions.{" "}
              {oneList
                ? `One list for everything you make, your ${w.many} included. Independent of your data region.`
                : `Also the languages your waitlists are offered in. Each ${w.one} can override these in its own Strategy settings. Independent of your data region.`}{" "}
              <a href="/help/languages" className="text-sky-700 hover:underline dark:text-sky-400">
                How languages work
              </a>
            </p>
          ) : (
            <p className="text-sm text-neutral-500">
              The default content language for your {w.many}, and the languages your
              waitlists are offered in. Each {w.one} can override these in its own
              Strategy settings. Independent of your data region.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Default language</label>
          <select
            value={defaultLocale}
            onChange={(e) => setContentLanguage(e.target.value)}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {LOCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!isLiveSupportedLocale(defaultLocale) ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              The post-signup voice chat doesn&apos;t support {languageName(defaultLocale)} yet, so
              it will run in English where enabled.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">
            Also offer in{" "}
            <span className="font-normal text-neutral-400">
              (visitors auto-detect into these and can switch)
            </span>
          </label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {LOCALES.filter((l) => l.code !== defaultLocale).map((l) => (
              <label key={l.code} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={supportedLocales.includes(l.code)}
                  onChange={() => toggleSupportedLocale(l.code)}
                />
                {l.liveCode ? l.name : `${l.name} (text only)`}
              </label>
            ))}
          </div>
        </div>

        {oneList ? (
          <ReadersTable defaultLocale={defaultLocale} supportedLocales={supportedLocales} readers={readers} minReaders={minReaders} />
        ) : null}

        {oneList ? (
          <div className="space-y-1">
            <label htmlFor="min-readers" className="block text-sm font-medium">
              Readers a language needs
            </label>
            <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
              Make a version once a language has at least
              <input
                id="min-readers"
                type="number"
                min={1}
                max={MAX_MIN_READERS}
                step={1}
                value={minReaders}
                disabled={!canSetMinReaders}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setMinReaders(Math.min(MAX_MIN_READERS, Math.max(1, n)));
                  setStatus("idle");
                }}
                className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
              />
              readers.
            </p>
            {!canSetMinReaders ? <p className="text-xs text-neutral-500">Only an admin can change this number.</p> : null}
            {translations ? (
              <p className="text-xs text-neutral-500">
                New versions are drafts. Until you approve them, readers get {languageName(defaultLocale)}. When you publish a change to a
                journey email, its translations are updated and come back for you to check.
              </p>
            ) : null}
          </div>
        ) : null}

        {pages && supportedLocales.length > 1 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Where each language goes</p>
            <p className="text-xs text-neutral-500">
              Google wants each language at its own address. A folder like /fr/ is simplest. An article&apos;s version goes at its
              language&apos;s folder and the article&apos;s slug, and you can change it on the article.
            </p>
            {supportedLocales
              .filter((code) => code !== defaultLocale)
              .map((code) => (
                <label key={code} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-40 text-neutral-600 dark:text-neutral-400">{languageName(code)}</span>
                  <input
                    type="url"
                    inputMode="url"
                    placeholder={`https://yourbrand.com/${code}/blog/`}
                    value={siteAddresses[code] ?? ""}
                    disabled={!canSetMinReaders}
                    onChange={(e) => {
                      setSiteAddresses({ ...siteAddresses, [code]: e.target.value.slice(0, 300) });
                      setStatus("idle");
                    }}
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </label>
              ))}
            <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={translatedNote}
                disabled={!canSetMinReaders}
                onChange={(e) => {
                  setTranslatedNote(e.target.checked);
                  setStatus("idle");
                }}
              />
              Add a line to translated articles, in their language: &ldquo;Translated from the original and checked by our team.&rdquo;
            </label>
            {!canSetMinReaders ? <p className="text-xs text-neutral-500">Only an admin can change where each language goes.</p> : null}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={status === "saving"}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {status === "saving" ? "Saving…" : "Save"}
          </button>
          {status === "saved" ? <span className="text-xs text-green-600">Saved.</span> : null}
          {status === "error" ? (
            <span className="text-xs text-red-600">{saveError ?? "Save failed."}</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Each language in the list with its readers and whether it has enough for its own version (LANGUAGE_READERS_ENABLED). */
function ReadersTable({
  defaultLocale,
  supportedLocales,
  readers,
  minReaders,
}: {
  defaultLocale: string;
  supportedLocales: string[];
  readers: Record<string, number> | null;
  minReaders: number;
}) {
  const list = [defaultLocale, ...supportedLocales.filter((c) => c !== defaultLocale)];
  if (list.length < 2) return null;
  const defaultName = languageName(defaultLocale);
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-neutral-500">
          <tr>
            <th className="py-1 font-medium">Language</th>
            <th className="py-1 font-medium">Readers</th>
            <th className="py-1 font-medium">Gets its own version</th>
          </tr>
        </thead>
        <tbody>
          {list.map((code) => {
            const info = localeInfo(code);
            const count = readers?.[code];
            const isDefault = code === defaultLocale;
            const { ready, more } = versionReadiness(count ?? 0, minReaders);
            return (
              <tr key={code} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-1.5">
                  {info.name}
                  {info.nativeName && info.nativeName !== info.name ? <span className="text-neutral-400"> · {info.nativeName}</span> : null}
                  {isDefault ? <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">Default</span> : null}
                </td>
                <td className="py-1.5 tabular-nums">{count === undefined ? "Not counted yet" : count.toLocaleString()}</td>
                <td className="py-1.5 text-neutral-600 dark:text-neutral-400">
                  {isDefault
                    ? `Always. Everything is written in ${defaultName} first.`
                    : count === undefined
                      ? "Not yet"
                      : ready
                        ? `Yes, ${minReaders} or more readers`
                        : `Not yet, ${more} more ${more === 1 ? "reader" : "readers"}. They get ${defaultName} until then.`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-neutral-500">
        Readers are people whose language we know, from sign ups and your product. Anyone we don&apos;t know counts as{" "}
        {defaultName}. Counted again each day, and when you change the list.
      </p>
    </div>
  );
}
