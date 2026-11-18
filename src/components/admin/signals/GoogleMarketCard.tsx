"use client";

import { useEffect, useState } from "react";

/**
 * Settings › Google market (BRAND_SIGNALS_ENABLED): which country's Google, in which language, the
 * brand's questions are looked up in ("Get from Google" in a blog brief). Admins change it;
 * everyone else sees it. /help/write-and-schedule#get-from-google explains it.
 */

interface MarketData {
  market: { country: string; language: string };
  chosen: boolean;
  label: string;
  countries: Array<{ country: string; name: string; language: string }>;
  languages: Array<{ code: string; name: string }>;
}

const SELECT =
  "mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";

export function GoogleMarketCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<MarketData | null>(null);
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void fetch("/api/admin/settings/search-market")
      .then((r) => (r.ok ? (r.json() as Promise<MarketData>) : null))
      .then((d) => {
        if (gone || !d) return;
        setData(d);
        setCountry(d.market.country);
        setLanguage(d.market.language);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  if (!data) return null;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/settings/search-market", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market: { country, language } }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setMessage(res?.status === 403 ? "Only admins can change the Google market." : "That didn't save. Try again in a moment.");
      return;
    }
    const saved = (await res.json()) as { label: string; chosen: boolean; market: MarketData["market"] };
    setData({ ...data, ...saved });
    setMessage(`Saved. Questions are looked up on ${saved.label}.`);
  };

  const pickCountry = (c: string) => {
    setCountry(c);
    const usual = data.countries.find((x) => x.country === c)?.language;
    if (usual) setLanguage(usual);
  };

  const changed = country !== data.market.country || language !== data.market.language;
  return (
    <section className="max-w-2xl space-y-2" aria-labelledby="google-market">
      <h2 id="google-market" className="text-sm font-semibold">
        Google market
      </h2>
      <div className="space-y-3 rounded-md border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-300">
          Where &quot;Get from Google&quot; looks your questions up: {data.label}
          {data.chosen ? "." : " (the default)."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Country
            <select value={country} onChange={(e) => pickCountry(e.target.value)} disabled={!isAdmin || busy} className={SELECT}>
              {data.countries.map((c) => (
                <option key={c.country} value={c.country}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Language
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={!isAdmin || busy} className={SELECT}>
              {data.languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !changed}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Only admins can change it.</p>
        )}
        {message ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-300" aria-live="polite">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
