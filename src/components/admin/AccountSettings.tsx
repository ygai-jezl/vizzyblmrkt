"use client";

import { useEffect, useState } from "react";
import {
  LOCALES,
  DEFAULT_LOCALE,
  isLiveSupportedLocale,
  languageName,
} from "@/lib/i18n/locale";

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
}

export function AccountSettings() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultLocale, setDefaultLocale] = useState(DEFAULT_LOCALE);
  const [supportedLocales, setSupportedLocales] = useState<string[]>([DEFAULT_LOCALE]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/account/locale");
        if (!res.ok) throw new Error("load_failed");
        const data = (await res.json()) as LocaleConfig;
        if (active) {
          setDefaultLocale(data.defaultLocale);
          setSupportedLocales(data.supportedLocales);
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
        body: JSON.stringify({ defaultLocale, supportedLocales }),
      });
      if (!res.ok) throw new Error("save_failed");
      const data = (await res.json()) as LocaleConfig;
      setDefaultLocale(data.defaultLocale);
      setSupportedLocales(data.supportedLocales);
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
          <p className="text-sm text-neutral-500">
            The default content language for your launches, and the languages your
            waitlists are offered in. Each launch can override these in its own
            Strategy settings. Independent of your data region.
          </p>
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
