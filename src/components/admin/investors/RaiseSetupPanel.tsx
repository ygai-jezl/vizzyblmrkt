"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RAISE_CURRENCIES, type RaiseKit } from "@/lib/raise/pipeline/presets";
import { SETUP_WORDS } from "@/lib/raise/pipeline/words";
import { Banner, Button, inputClass } from "../connect/ui";
import { pressSetup, setupErrorText, setupPreview, type SetupDone, type SetupPreview } from "./investorsApi";

/**
 * Settings › Data model, Ready-made fields (RAISE_PIPELINE_ENABLED, admins only): Set up for raising
 * or Set up for funding, the brand's likelier kit first, with the currency amounts are in. It shows
 * what a press would add, which of the team's own fields it would use, and what it keeps, before
 * anything changes; the button waits until that preview is for the kit and currency picked. One
 * press saves it as one version, and pressing again adds only what is missing. The field list below
 * (`children`, Data model) loads again after a press that changed something, so it shows the new fields.
 */

/** The two kits, the brand's likelier one first. Pure. */
export function kitOrder(first: RaiseKit): RaiseKit[] {
  return first === "funding" ? ["funding", "raising"] : ["raising", "funding"];
}

export interface PreviewLines {
  /** "Adds 10 fields and 37 options.", that it only uses what is there, or that everything is already here. */
  summary: string;
  /** The new fields' names on one line, then each field that gains options. */
  lines: string[];
  /** The team's own fields it starts using, and who that puts on the board, before anything changes. */
  uses: string[];
  keeps: string | null;
  notes: string[];
}

/** What the preview says. Pure. */
export function previewLines(plan: SetupPreview["plan"]): PreviewLines {
  const notes = plan.kept.map((k) => k.note);
  if (plan.nothing) return { summary: SETUP_WORDS.nothing, lines: [], uses: [], keeps: null, notes };
  const made = new Set(plan.addFields.map((f) => f.label));
  const gains = new Map<string, string[]>();
  for (const o of plan.addOptions) if (!made.has(o.field)) gains.set(o.field, [...(gains.get(o.field) ?? []), o.label]);
  const lines = [...(made.size ? [[...made].join(", ")] : []), ...[...gains].map(([field, labels]) => `${field}: ${labels.join(", ")}`)];
  const stage = plan.adopt.find((a) => a.preset === "raise.stage");
  const uses = plan.adopt.length ? [SETUP_WORDS.uses(plan.adopt.map((a) => a.label)), ...(stage ? [SETUP_WORDS.usesStage(stage.label)] : [])] : [];
  const adds = plan.addFields.length + plan.addOptions.length > 0;
  return { summary: adds ? SETUP_WORDS.preview(plan.addFields.length, plan.addOptions.length) : SETUP_WORDS.usesOnly, lines, uses, keeps: SETUP_WORDS.keeps, notes };
}

/** Whether the preview shown is for the kit and currency picked, so the button can be pressed. Pure. */
export function previewIsFor(preview: Pick<SetupPreview, "kit" | "currency"> | null, kit: RaiseKit, currency: string): boolean {
  return !!preview && preview.kit === kit && preview.currency === currency;
}

export interface SetupDoneState {
  message: string;
  /** The board's tab after the press; null while the brand has no board. */
  board: RaiseKit | null;
  href: string;
}

/**
 * What a press's answer shows, and whether the field list below loads again. Where the board is
 * shows whenever the brand has one, so a press that only starts using the team's own fields says
 * so too. Pure.
 */
export function pressOutcome(data: Pick<SetupDone, "message" | "boardHref" | "board" | "changed">): { done: SetupDoneState; reload: boolean } {
  return { done: { message: data.message, board: data.board, href: data.boardHref }, reload: data.changed };
}

/** The box as it is drawn. */
export function SetupView({
  preview,
  kit,
  currency,
  busy,
  done,
  error,
  looking = false,
  previewError = null,
  onKit,
  onCurrency,
  onPress,
  onRetry,
}: {
  preview: SetupPreview;
  kit: RaiseKit;
  currency: string;
  busy: boolean;
  done: SetupDoneState | null;
  error: string | null;
  /** A preview for the kit or currency just picked is on its way. */
  looking?: boolean;
  /** The preview for the kit and currency picked didn't load. */
  previewError?: string | null;
  onKit: (kit: RaiseKit) => void;
  onCurrency: (code: string) => void;
  onPress: () => void;
  onRetry?: () => void;
}) {
  // The old kit's plan is never shown for the new pick, and never pressed.
  const ready = !looking && !previewError && previewIsFor(preview, kit, currency);
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
      <div aria-live="polite" className="space-y-1 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
        {ready ? (
          <>
            <p className="font-medium">{shown.summary}</p>
            {shown.lines.map((line) => (
              <p key={line} className="text-neutral-600 dark:text-neutral-400">
                {line}
              </p>
            ))}
            {shown.uses.map((line) => (
              <p key={line} className="font-medium text-amber-800 dark:text-amber-300">
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
          </>
        ) : previewError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-red-700 dark:text-red-400">{previewError}</p>
            {onRetry ? (
              <Button onClick={onRetry} disabled={busy}>
                {SETUP_WORDS.tryAgain}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-neutral-500">{SETUP_WORDS.previewLoading}</p>
        )}
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
      <Button tone="primary" disabled={busy || !ready} onClick={onPress}>
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
  const [looking, setLooking] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SetupDoneState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a press that changed something, so the field list below loads again.
  const [version, setVersion] = useState(0);
  // Only the newest preview asked for is shown: an older answer arriving late is dropped.
  const asked = useRef(0);

  const look = useCallback((k?: RaiseKit, c?: string) => {
    const mine = ++asked.current;
    setLooking(true);
    setPreviewError(null);
    void setupPreview(k, c).then((r) => {
      if (mine !== asked.current) return;
      setLooking(false);
      if (!r.ok) return setPreviewError(setupErrorText(r.data));
      setPreview(r.data);
      setKit(r.data.kit);
      setCurrency(r.data.currency);
    });
  }, []);
  useEffect(() => look(), [look]);

  async function press() {
    if (!previewIsFor(preview, kit, currency)) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await pressSetup(kit, currency);
    setBusy(false);
    if (!r.ok) return setError(setupErrorText(r.data));
    const { done: shown, reload } = pressOutcome(r.data);
    setDone(shown);
    if (reload) setVersion((v) => v + 1);
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
          looking={looking}
          previewError={previewError}
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
          onRetry={() => look(kit, currency)}
        />
      ) : previewError ? (
        <Banner tone="err">{previewError}</Banner>
      ) : (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
      <div key={version}>{children}</div>
    </div>
  );
}
