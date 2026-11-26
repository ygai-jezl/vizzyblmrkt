"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RAISE_CURRENCIES, type RaiseKit } from "@/lib/raise/pipeline/presets";
import { SETUP_WORDS } from "@/lib/raise/pipeline/words";
import { Banner, Button, inputClass } from "../connect/ui";
import { pressSetup, setupErrorText, setupPreview, type SetupPreview } from "./investorsApi";

/**
 * Settings › Data model, Ready-made fields (RAISE_PIPELINE_ENABLED, admins only): Set up for raising
 * or Set up for funding, the brand's likelier kit first, with the currency amounts are in. It shows
 * what a press would add and keep before anything changes; one press saves it as one version, and
 * pressing again adds only what is missing. The field list below (`children`, Data model) loads
 * again after a press that added something, so it shows the new fields.
 */

/** The two kits, the brand's likelier one first. Pure. */
export function kitOrder(first: RaiseKit): RaiseKit[] {
  return first === "funding" ? ["funding", "raising"] : ["raising", "funding"];
}

export interface PreviewLines {
  /** "Adds 10 fields and 37 options.", or that everything is already here. */
  summary: string;
  /** The new fields' names on one line, then each field of the team's that gains options. */
  lines: string[];
  keeps: string | null;
  notes: string[];
}

/** What the preview says. Pure. */
export function previewLines(plan: SetupPreview["plan"]): PreviewLines {
  const notes = plan.kept.map((k) => k.note);
  if (plan.nothing) return { summary: SETUP_WORDS.nothing, lines: [], keeps: null, notes };
  const made = new Set(plan.addFields.map((f) => f.label));
  const gains = new Map<string, string[]>();
  for (const o of plan.addOptions) if (!made.has(o.field)) gains.set(o.field, [...(gains.get(o.field) ?? []), o.label]);
  const lines = [...(made.size ? [[...made].join(", ")] : []), ...[...gains].map(([field, labels]) => `${field}: ${labels.join(", ")}`)];
  return { summary: SETUP_WORDS.preview(plan.addFields.length, plan.addOptions.length), lines, keeps: SETUP_WORDS.keeps, notes };
}

export interface SetupDoneState {
  message: string;
  /** The board's tab after the press; null when nothing was added. */
  board: RaiseKit | null;
  href: string;
}

/** The box as it is drawn. */
export function SetupView({
  preview,
  kit,
  currency,
  busy,
  done,
  error,
  onKit,
  onCurrency,
  onPress,
}: {
  preview: SetupPreview;
  kit: RaiseKit;
  currency: string;
  busy: boolean;
  done: SetupDoneState | null;
  error: string | null;
  onKit: (kit: RaiseKit) => void;
  onCurrency: (code: string) => void;
  onPress: () => void;
}) {
  const shown = previewLines(preview.plan);
  const currencies: string[] = [...RAISE_CURRENCIES];
  if (!currencies.includes(currency)) currencies.push(currency);
  return (
    <section aria-labelledby="raise-setup-title" className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div>
        <h2 id="raise-setup-title" className="text-base font-semibold">
          {SETUP_WORDS.title}
        </h2>
        <p className="max-w-prose text-sm text-neutral-500 dark:text-neutral-400">{SETUP_WORDS.lead}</p>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">{SETUP_WORDS.title}</legend>
        {kitOrder(preview.firstKit).map((k) => (
          <label
            key={k}
            className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${kit === k ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"}`}
          >
            <input type="radio" name="raise-kit" value={k} checked={kit === k} disabled={busy} onChange={() => onKit(k)} className="mt-0.5" />
            <span>
              <span className="block font-medium">{SETUP_WORDS.kits[k].button}</span>
              <span className="block text-xs text-neutral-500">{SETUP_WORDS.kits[k].line}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block max-w-[12rem] space-y-1 text-sm">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{SETUP_WORDS.amountsIn}</span>
        <select value={currency} disabled={busy} onChange={(e) => onCurrency(e.target.value)} className={inputClass}>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
        <p className="font-medium">{shown.summary}</p>
        {shown.lines.map((line) => (
          <p key={line} className="text-neutral-600 dark:text-neutral-400">
            {line}
          </p>
        ))}
        {shown.keeps ? <p className="text-neutral-600 dark:text-neutral-400">{shown.keeps}</p> : null}
        {shown.notes.length ? (
          <ul className="ml-4 list-disc text-xs text-neutral-500">
            {shown.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? <Banner tone="err">{error}</Banner> : null}
      {done ? (
        <Banner tone="ok">
          {done.message}
          {done.board ? (
            <>
              {" "}
              {SETUP_WORDS.where(done.board)}{" "}
              <Link href={done.href} className="font-medium underline underline-offset-2">
                {SETUP_WORDS.openBoard}
              </Link>
            </>
          ) : null}
        </Banner>
      ) : null}
      <Button tone="primary" disabled={busy} onClick={onPress}>
        {busy ? SETUP_WORDS.busy : SETUP_WORDS.kits[kit].button}
      </Button>
    </section>
  );
}

/** The Ready-made fields box above Data model's field list (`children`). */
export function RaiseSetupPanel({ children }: { children?: ReactNode }) {
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  const [kit, setKit] = useState<RaiseKit>("raising");
  const [currency, setCurrency] = useState("USD");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SetupDoneState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a press that added something, so the field list below loads again.
  const [version, setVersion] = useState(0);

  const look = useCallback((k?: RaiseKit, c?: string) => {
    void setupPreview(k, c).then((r) => {
      if (!r.ok) return setLoadError(setupErrorText(r.data));
      setLoadError(null);
      setPreview(r.data);
      setKit(r.data.kit);
      setCurrency(r.data.currency);
    });
  }, []);
  useEffect(() => look(), [look]);

  async function press() {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await pressSetup(kit, currency);
    setBusy(false);
    if (!r.ok) return setError(setupErrorText(r.data));
    const added = r.data.added.fields + r.data.added.options > 0;
    setDone({ message: r.data.message, board: added ? (r.data.board ?? kit) : null, href: r.data.boardHref });
    if (added) setVersion((v) => v + 1);
    look(kit, currency);
  }

  return (
    <div className="space-y-6">
      {preview ? (
        <SetupView
          preview={preview}
          kit={kit}
          currency={currency}
          busy={busy}
          done={done}
          error={error}
          onKit={(k) => {
            setKit(k);
            setDone(null);
            look(k, currency);
          }}
          onCurrency={(c) => {
            setCurrency(c);
            look(kit, c);
          }}
          onPress={() => void press()}
        />
      ) : loadError ? (
        <Banner tone="err">{loadError}</Banner>
      ) : (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
      <div key={version}>{children}</div>
    </div>
  );
}
