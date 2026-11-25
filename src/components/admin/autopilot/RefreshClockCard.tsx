"use client";

import { useEffect, useState } from "react";

/**
 * Brand › Brand map › Refresh clock (BLOG_FRESHNESS_ENABLED): how long a live article goes before
 * it is due a refresh, either the test of 20, 30 and 45 days or one fixed clock, and how many of
 * Next up's three picks may be refreshes. Shows what the freshness watch counted last. Admins
 * change it. /help/write-and-schedule#freshness explains it.
 */

type Clock = "test" | 20 | 30 | 45;

/** Which clock works (BLOG_REFRESH_ENABLED), as src/lib/content/blog/refreshReadout.ts sums it up. */
interface ClockRow {
  clockDays: 20 | 30 | 45;
  refreshes: number;
  nothingShare: number | null;
  proposedAvg: number | null;
  acceptedAvg: number | null;
  costCentsAvg: number | null;
  clickLift: { mean: number; low: number; high: number } | null;
  resultsNeeded: number;
}

interface RefreshData {
  clock: Clock;
  share: number;
  keepTesting?: boolean;
  counts: { fresh: number; soon: number; due: number } | null;
  byClock: Record<"20" | "30" | "45", number> | null;
  lookedAt: string | null;
  readout?: { clocks: ClockRow[]; since: string | null; suggestion: { clockDays: 20 | 30 | 45; text: string } | null; line: string };
}

/** Said under the readout. */
export const READOUT_NOTE = "Cost is an estimate at Google's list prices. Search Console's numbers stay with this brand.";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
/** "Too early" until a clock has its results; then the range, never one number. */
export function liftText(c: ClockRow): string {
  if (!c.clickLift) return `Too early: ${c.resultsNeeded} more refresh${c.resultsNeeded === 1 ? "" : "es"}`;
  return `${pct(c.clickLift.mean)} (${pct(c.clickLift.low)} to ${pct(c.clickLift.high)})`;
}

const CARD = "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const SELECT =
  "mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const CLOCKS: Array<{ value: Clock; label: string }> = [
  { value: "test", label: "Test 20, 30 and 45 days" },
  { value: 20, label: "Every 20 days" },
  { value: 30, label: "Every 30 days" },
  { value: 45, label: "Every 45 days" },
];

export function RefreshClockCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<RefreshData | null>(null);
  const [clock, setClock] = useState<Clock>("test");
  const [share, setShare] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void fetch("/api/admin/settings/refresh")
      .then((r) => (r.ok ? (r.json() as Promise<RefreshData>) : null))
      .then((d) => {
        if (gone || !d) return;
        setData(d);
        setClock(d.clock);
        setShare(d.share);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  if (!data) return null;

  const save = async (next: { clock: Clock; share: number; keepTesting?: boolean } = { clock, share }) => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/settings/refresh", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setMessage(res?.status === 403 ? "Only admins can change the refresh clock." : "That didn't save. Try again in a moment.");
      return;
    }
    setData({ ...data, clock: next.clock, share: next.share, keepTesting: next.clock !== "test" && next.keepTesting === true });
    setClock(next.clock);
    setMessage(
      next.clock === "test"
        ? "Saved. New live articles are spread across 20, 30 and 45 days."
        : next.keepTesting
          ? `Saved. Live articles are due every ${next.clock} days, and a tenth of new ones keep testing.`
          : `Saved. Live articles are due every ${next.clock} days.`,
    );
  };

  const changed = clock !== data.clock || share !== data.share;
  const c = data.counts;
  const b = data.byClock;
  return (
    <section className={CARD} aria-labelledby="refresh-clock">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="refresh-clock" className="text-sm font-semibold">
          Refresh clock
        </h2>
        {c ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {c.due} due, {c.soon} soon, {c.fresh} fresh
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
        How long a live article goes before it is due a refresh. The test spreads new articles across three clocks, so you
        learn which works for your brand.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Clock
          <select
            id="refresh-clock-select"
            value={String(clock)}
            onChange={(e) => setClock(e.target.value === "test" ? "test" : (Number(e.target.value) as Clock))}
            disabled={!isAdmin || busy}
            className={SELECT}
          >
            {CLOCKS.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Refreshes in Next up
          <select id="refresh-share-select" value={share} onChange={(e) => setShare(Number(e.target.value))} disabled={!isAdmin || busy} className={SELECT}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "None of the three picks" : `Up to ${n} of the three picks`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {b ? (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Live articles by clock: {b["20"]} on 20 days, {b["30"]} on 30, {b["45"]} on 45.
        </p>
      ) : null}
      {data.readout ? (
        <div className="mt-3 space-y-2">
          <h3 className="text-xs font-semibold">Which clock works</h3>
          <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="bg-neutral-50 text-[10.5px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Clock</th>
                  <th className="px-2 py-1.5 font-medium">Refreshes</th>
                  <th className="px-2 py-1.5 font-medium">Nothing to change</th>
                  <th className="px-2 py-1.5 font-medium">Changes accepted</th>
                  <th className="px-2 py-1.5 font-medium">Cost each</th>
                  <th className="px-2 py-1.5 font-medium">Clicks after 28 days, against articles left alone</th>
                </tr>
              </thead>
              <tbody>
                {data.readout.clocks.map((c) => (
                  <tr key={c.clockDays} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-2 py-1.5">{c.clockDays} days</td>
                    <td className="px-2 py-1.5">{c.refreshes}</td>
                    <td className="px-2 py-1.5">{c.nothingShare === null ? "" : `${Math.round(c.nothingShare * 100)}%`}</td>
                    <td className="px-2 py-1.5">{c.acceptedAvg === null ? "" : `${c.acceptedAvg} of ${c.proposedAvg ?? 0}`}</td>
                    <td className="px-2 py-1.5">{c.costCentsAvg === null ? "" : `about ${Math.round(c.costCentsAvg)}¢`}</td>
                    <td className={`px-2 py-1.5 ${c.clickLift ? "" : "text-neutral-500"}`}>{liftText(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rounded-md bg-neutral-50 px-2 py-1.5 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">{data.readout.line}</p>
          {isAdmin && data.readout.suggestion && data.clock !== data.readout.suggestion.clockDays ? (
            <button
              type="button"
              onClick={() => void save({ clock: data.readout!.suggestion!.clockDays, share, keepTesting: true })}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Use {data.readout.suggestion.clockDays} days
            </button>
          ) : null}
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{READOUT_NOTE}</p>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <button
            type="button"
            onClick={() => void save({ clock, share })}
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
