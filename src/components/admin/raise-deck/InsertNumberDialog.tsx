"use client";

import { useState } from "react";
import { Modal } from "@/components/admin/email/Modal";
import type { NumberOptions } from "@/lib/raise/docs/metrics";
import { pendingServerBlock, typedLocalBlock } from "@/lib/raise/docs/edit";
import { RAISE_DOC_LIMITS as L, type MetricBlock } from "@/lib/raise/docs/types";
import { EDITOR_WORDS, NUMBER_DIALOG } from "@/lib/raise/docs/words";

type Choice = "waitlist" | "growth" | "launch" | "typed";
type Row = { label: string; value: string };

const FIELD = "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/** A typed figure: digits with commas, spaces or a currency sign left out. Null when it isn't a number in range. */
export function typedValue(raw: string): number | null {
  const s = raw.replace(/[,\s£$€%]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && Math.abs(v) <= L.maxValue ? v : null;
}

/**
 * Insert a number: one of YouGrow's own (sign-ups, sign-up growth, the people on one launch), each
 * filled by the server when the slide is saved and shown as Seen by YouGrow, or a number typed here,
 * shown as Typed by you. A choice with no data is shown and turned off. Launches show only while the
 * one People list is on.
 */
export function InsertNumberDialog({ open, options, onClose, onInsert }: { open: boolean; options: NumberOptions; onClose: () => void; onInsert: (b: MetricBlock) => void }) {
  const [pick, setPick] = useState<Choice>(options.waitlist.hasData ? "waitlist" : "typed");
  const [weeks, setWeeks] = useState<4 | 8 | 12>(12);
  const [weekly, setWeekly] = useState(false);
  const [launchId, setLaunchId] = useState(options.launches?.[0]?.id ?? "");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<MetricBlock["unit"]>("count");
  const [currency, setCurrency] = useState<"GBP" | "USD" | "EUR">("GBP");
  const [per, setPer] = useState<"none" | "month" | "year">("none");
  const [from, setFrom] = useState("");
  const [several, setSeveral] = useState(false);
  const [rows, setRows] = useState<Row[]>([{ label: "", value: "" }]);
  const [error, setError] = useState<string | null>(null);

  function insert() {
    setError(null);
    if (pick === "waitlist") return onInsert(pendingServerBlock({ meaning: "waitlistSignups", grain: weekly ? "week" : "total", weeks }));
    if (pick === "growth") return onInsert(pendingServerBlock({ meaning: "signupGrowth", grain: "total", weeks }));
    if (pick === "launch") {
      const launch = options.launches?.find((l) => l.id === launchId);
      if (!launch) return setError(EDITOR_WORDS.launchPick);
      return onInsert(pendingServerBlock({ meaning: "launchSignups", grain: "total", launchId: launch.id, launchName: launch.name }));
    }
    const series = several ? rows.map((r) => ({ label: r.label.trim(), value: typedValue(r.value) })).filter((r) => r.label && r.value !== null) : [];
    const figure = several ? (series.at(-1)?.value ?? null) : typedValue(value);
    if (!name.trim() || figure === null) return setError(EDITOR_WORDS.typedMissing);
    onInsert(
      typedLocalBlock({
        name,
        value: figure,
        unit,
        currency: unit === "money" ? currency : undefined,
        per: per === "none" ? null : per,
        from,
        series: series.length > 1 ? series.map((r) => ({ label: r.label, value: r.value as number })) : undefined,
      }),
    );
  }

  const choice = (value: Choice, title: string, disabled: boolean, line?: string) => (
    <label className={`flex items-start gap-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="radio" name="raise-number" checked={pick === value} disabled={disabled} onChange={() => setPick(value)} className="mt-0.5" />
      <span>
        <span className="block font-medium">{title}</span>
        {line ? <span className="block text-xs text-neutral-500">{line}</span> : null}
      </span>
    </label>
  );

  return (
    <Modal open={open} onClose={onClose} title={NUMBER_DIALOG.title}>
      <div className="space-y-4">
        <div className="space-y-2">
          {choice("waitlist", NUMBER_DIALOG.waitlist, !options.waitlist.hasData, options.waitlist.hasData ? undefined : NUMBER_DIALOG.noSignups)}
          {pick === "waitlist" ? (
            <div className="ml-6 flex flex-wrap items-center gap-3 text-sm">
              <select aria-label={NUMBER_DIALOG.waitlist} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) as 4 | 8 | 12)} className={`${FIELD} w-auto`}>
                {([4, 8, 12] as const).map((w) => (
                  <option key={w} value={w}>
                    {NUMBER_DIALOG.weeks[w]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
                {NUMBER_DIALOG.weekly}
              </label>
            </div>
          ) : null}
          {choice("growth", NUMBER_DIALOG.growth, !options.growth.hasData, options.growth.hasData ? NUMBER_DIALOG.growthLine : NUMBER_DIALOG.noSignups)}
          {options.launches ? (
            <>
              {choice("launch", NUMBER_DIALOG.launch, options.launches.length === 0)}
              {pick === "launch" ? (
                <select aria-label={NUMBER_DIALOG.launch} value={launchId} onChange={(e) => setLaunchId(e.target.value)} className={`${FIELD} ml-6 w-auto`}>
                  {options.launches.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </>
          ) : null}
          {choice("typed", NUMBER_DIALOG.typed, false)}
          {pick === "typed" ? (
            <div className="ml-6 grid gap-2 sm:grid-cols-2">
              <label className="text-xs sm:col-span-2">
                {NUMBER_DIALOG.typedName}
                <input value={name} maxLength={L.typedName} onChange={(e) => setName(e.target.value)} placeholder={NUMBER_DIALOG.typedNamePlaceholder} className={FIELD} />
              </label>
              {!several ? (
                <label className="text-xs">
                  {NUMBER_DIALOG.typedValue}
                  <input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} className={FIELD} />
                </label>
              ) : null}
              <label className="text-xs">
                {NUMBER_DIALOG.unit}
                <select value={unit} onChange={(e) => setUnit(e.target.value as MetricBlock["unit"])} className={FIELD}>
                  {(["count", "money", "percent"] as const).map((u) => (
                    <option key={u} value={u}>
                      {NUMBER_DIALOG.units[u]}
                    </option>
                  ))}
                </select>
              </label>
              {unit === "money" ? (
                <label className="text-xs">
                  {NUMBER_DIALOG.currency}
                  <select value={currency} onChange={(e) => setCurrency(e.target.value as "GBP" | "USD" | "EUR")} className={FIELD}>
                    {(["GBP", "USD", "EUR"] as const).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="text-xs">
                {NUMBER_DIALOG.per}
                <select value={per} onChange={(e) => setPer(e.target.value as "none" | "month" | "year")} className={FIELD}>
                  {(["none", "month", "year"] as const).map((p) => (
                    <option key={p} value={p}>
                      {NUMBER_DIALOG.pers[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs sm:col-span-2">
                {NUMBER_DIALOG.from}
                <input value={from} maxLength={L.typedFrom} onChange={(e) => setFrom(e.target.value)} placeholder={NUMBER_DIALOG.fromPlaceholder} className={FIELD} />
              </label>
              <label className="flex items-center gap-1 text-xs sm:col-span-2">
                <input type="checkbox" checked={several} onChange={(e) => setSeveral(e.target.checked)} />
                {NUMBER_DIALOG.several}
              </label>
              {several ? (
                <div className="space-y-1 sm:col-span-2">
                  {rows.map((r, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        aria-label={EDITOR_WORDS.rowLabel}
                        placeholder={EDITOR_WORDS.rowLabel}
                        value={r.label}
                        maxLength={24}
                        onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
                        className={FIELD}
                      />
                      <input
                        aria-label={EDITOR_WORDS.rowValue}
                        placeholder={EDITOR_WORDS.rowValue}
                        value={r.value}
                        inputMode="decimal"
                        onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))}
                        className={FIELD}
                      />
                    </div>
                  ))}
                  {rows.length < L.series ? (
                    <button type="button" onClick={() => setRows([...rows, { label: "", value: "" }])} className="text-xs text-blue-700 hover:underline dark:text-blue-300">
                      {EDITOR_WORDS.addRow}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500">{NUMBER_DIALOG.line}</p>
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            {NUMBER_DIALOG.cancel}
          </button>
          <button type="button" onClick={insert} className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-white dark:bg-white dark:text-neutral-900">
            {NUMBER_DIALOG.insert}
          </button>
        </div>
      </div>
    </Modal>
  );
}
