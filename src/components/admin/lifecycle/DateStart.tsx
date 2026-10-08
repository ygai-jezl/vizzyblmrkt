"use client";

import { useState } from "react";
import { DATE_PASSED_EVENT, DATE_START_LIMITS, dateStartOf, type DateStart, type LifecycleJourney, type LifecycleSettings } from "@/lib/types/lifecycle";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { api, errorText, timeAgo } from "../connect/api";
import { Button, Field, inputClass } from "../connect/ui";
import { dateStartText } from "./model";

/**
 * A journey that starts when a date passes (LIFECYCLE_DATE_START): "Last active
 * was more than 14 days ago".
 *  - `DateStartField`, in Settings › Starts when: which of the catalog's date
 *    facts, how many days, and what happens when the date moves on. Saved with
 *    the draft; it goes live on publish, like every trigger.
 *  - `DateCheckStatus`, on the People tab: what today's check did, and "Check
 *    now" for when waiting for the daily one won't do (testing a new journey).
 */

const NEW_START = {
  days: DATE_START_LIMITS.defaultDays,
  windowDays: DATE_START_LIMITS.defaultWindowDays,
  stopWhenDateMoves: true,
  reenterAfterDays: DATE_START_LIMITS.defaultReenterAfterDays,
} as const;

/** `settings` starting when `fact` passes — or, with null, on sign-up again. */
export function withDateStart(settings: LifecycleSettings, fact: string | null): LifecycleSettings {
  if (!fact) return { ...settings, trigger: { ...settings.trigger, event: "user.signed_up", date: null } };
  const kept = settings.trigger.date ?? null;
  return { ...settings, trigger: { ...settings.trigger, event: DATE_PASSED_EVENT, afterJourneyId: null, date: { ...NEW_START, ...kept, fact } } };
}

const days = (v: string, fallback: number) => Math.min(DATE_START_LIMITS.maxDays, Math.max(1, Math.round(Number(v)) || fallback));

export function DateStartField({
  settings,
  catalog,
  readOnly,
  onChange,
}: {
  settings: LifecycleSettings;
  catalog: ConnectionCatalog | undefined;
  readOnly: boolean;
  onChange: (next: LifecycleSettings) => void;
}) {
  const start = dateStartOf(settings);
  const waiting = settings.trigger.event === DATE_PASSED_EVENT && !start;
  const dates = (catalog?.facts ?? []).filter((f) => f.type === "date");
  const known = start ? dates.find((f) => f.id === start.fact) : undefined;
  const set = (patch: Partial<DateStart>) => start && onChange({ ...settings, trigger: { ...settings.trigger, date: { ...start, ...patch } } });
  return (
    <div className="space-y-2">
      <Field
        label="Or when a date passes"
        hint={
          start || waiting
            ? undefined
            : dates.length
              ? "Pick a date to start this journey once it's a number of days ago — someone who hasn't been active for 14 days, say."
              : "Add a date fact to this product's catalog (Products › Catalog), such as when someone was last active, to start a journey from it."
        }
      >
        <select className={inputClass} value={start?.fact ?? ""} disabled={readOnly || (dates.length === 0 && !start)} onChange={(e) => onChange(withDateStart(settings, e.target.value || null))}>
          <option value="">No date</option>
          {dates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
          {start && !known ? <option value={start.fact}>{start.fact} (not a date fact in the catalog)</option> : null}
        </select>
      </Field>
      {waiting ? <p className="text-xs text-red-600">Choose the date this journey starts from.</p> : null}
      {start ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start when it was at least (days ago)">
              <input className={inputClass} type="number" min={1} max={DATE_START_LIMITS.maxDays} disabled={readOnly} value={start.days} onChange={(e) => set({ days: days(e.target.value, start.days) })} />
            </Field>
            <Field label="Leave out anyone more than (days) past that" hint="So going live doesn't take everyone who has already been quiet for months.">
              <input className={inputClass} type="number" min={1} max={DATE_START_LIMITS.maxDays} disabled={readOnly} value={start.windowDays} onChange={(e) => set({ windowDays: days(e.target.value, start.windowDays) })} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" disabled={readOnly} checked={start.stopWhenDateMoves} onChange={(e) => set({ stopWhenDateMoves: e.target.checked })} />
            <span>
              Stop when the date moves on
              <span className="block text-xs text-neutral-500">They came back, so the rest of the journey isn&rsquo;t sent. Checked again just before each email.</span>
            </span>
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={start.reenterAfterDays !== null}
              onChange={(e) => set({ reenterAfterDays: e.target.checked ? DATE_START_LIMITS.defaultReenterAfterDays : null })}
            />
            Let people enter again, no sooner than
            <input
              className={`${inputClass} w-20`}
              type="number"
              min={1}
              max={DATE_START_LIMITS.maxDays}
              aria-label="Days before someone can enter again"
              disabled={readOnly || start.reenterAfterDays === null}
              value={start.reenterAfterDays ?? ""}
              onChange={(e) => set({ reenterAfterDays: days(e.target.value, DATE_START_LIMITS.defaultReenterAfterDays) })}
            />
            days after they last entered
          </label>
          <p className="text-xs text-neutral-500">
            People enter when {dateStartText(settings, catalog)}. A check once a day (from 07:00 UTC) enrols them, and each email still goes
            out in their own send window. This journey&rsquo;s waits count from the day they enter.
            {start.reenterAfterDays === null ? " Each person enters once." : " One date is one entry: they enter again only after the date has moved on and passed the line again."}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** Today's check for a live journey that starts when a date passes, with "Check now". */
export function DateCheckStatus({ journey, canEdit, onChecked }: { journey: LifecycleJourney; canEdit: boolean; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  if (!journey.startsOnDate || !journey.publishedVersion) return null;
  const sweep = journey.dateSweep ?? null;
  const check = async () => {
    setBusy(true);
    setNote(null);
    const r = await api<{ checked: number; enrolled: number; finished: boolean; failed?: number }>(`/api/admin/lifecycle/journeys/${journey.id}/check-dates`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return setNote({ tone: "err", text: errorText(r.data) });
    const { checked, enrolled, finished, failed } = r.data;
    const text = `Checked ${checked} ${checked === 1 ? "person" : "people"}: ${enrolled} entered.${finished ? "" : " Still going — the rest are checked over the next few minutes."}`;
    // A check that couldn't decide about people is a problem, not a quiet day.
    setNote(failed ? { tone: "err", text: `${text} ${failed} couldn't be checked; they're tried again at the next check.` } : { tone: "ok", text });
    onChecked();
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
      <span className="text-neutral-600 dark:text-neutral-400">
        {sweep
          ? `Last check ${timeAgo(sweep.updatedAt)}: ${sweep.checked} read, ${sweep.enrolled} entered${sweep.failed ? `, ${sweep.failed} couldn't be checked` : ""}${sweep.status === "running" ? " (still going)" : ""}.`
          : "People are checked once a day, from 07:00 UTC."}
        {note ? <span className={note.tone === "err" ? " text-red-600" : " text-neutral-900 dark:text-neutral-100"}> {note.text}</span> : null}
      </span>
      {canEdit && journey.status === "active" ? (
        <Button disabled={busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check now"}
        </Button>
      ) : null}
    </div>
  );
}
