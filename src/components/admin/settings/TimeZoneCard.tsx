"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Settings › General › Time zone (BLOG_DATES_ENABLED): the zone a brand's article dates are
 * written in (Published and Updated, with their time, in the copy and the markup). Admins change
 * it; everyone else sees it. /help/write-and-schedule#dates explains it.
 */

interface ZoneData {
  timeZone: string;
  chosen: boolean;
}

const SELECT =
  "mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";

/** Every zone the browser knows, with the given ones, or just those when it can't list them. */
function zonesWith(...extra: string[]): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...extra.filter(Boolean), ...list])].sort((a, b) => a.localeCompare(b));
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function TimeZoneCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<ZoneData | null>(null);
  const [zone, setZone] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void fetch("/api/admin/settings/time-zone")
      .then((r) => (r.ok ? (r.json() as Promise<ZoneData>) : null))
      .then((d) => {
        if (gone || !d) return;
        setData(d);
        // Not set yet: offer the browser's own zone, so one Save sets it.
        setZone(d.chosen ? d.timeZone : browserZone());
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const zones = useMemo(() => zonesWith(zone, data?.timeZone ?? "", "UTC"), [zone, data?.timeZone]);
  if (!data) return null;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/settings/time-zone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeZone: zone }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setMessage(res?.status === 403 ? "Only admins can change the time zone." : "That didn't save. Try again in a moment.");
      return;
    }
    const saved = (await res.json()) as ZoneData;
    setData(saved);
    setMessage(`Saved. Article dates are written in ${saved.timeZone}.`);
  };

  const changed = !data.chosen || zone !== data.timeZone;
  return (
    <section className="max-w-2xl space-y-2" aria-labelledby="time-zone">
      <h2 id="time-zone" className="text-sm font-semibold">
        Time zone
      </h2>
      <div className="space-y-3 rounded-md border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-300">
          Your articles&apos; Published and Updated dates are written in {data.chosen ? data.timeZone : "UTC until you choose one"}.
        </p>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Time zone
          <select id="time-zone-select" value={zone} onChange={(e) => setZone(e.target.value)} disabled={!isAdmin || busy} className={SELECT}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
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
