"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { raiseDocHref } from "@/lib/raise/docs/paths";
import { LIST_WORDS } from "@/lib/raise/docs/words";
import { messageFor, newDeck } from "./api";

type Choice = "pre_seed" | "seed" | "lender";

/**
 * New deck on Content › Raise kit: what are you making, an optional brief, then one draft. Vizzy
 * drafts version 1 and the studio opens on it. When Vizzy couldn't write the words, the outline is
 * saved and the studio says so.
 */
export function NewDeckForm() {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>("pre_seed");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = choice === "lender" ? { audience: "lender" as const } : { audience: "investor" as const, stage: choice };
    const r = await newDeck({ ...body, ...(brief.trim() ? { brief: brief.trim() } : {}) });
    if (r.ok && r.data.doc) {
      const href = raiseDocHref(r.data.doc.id);
      router.push(r.data.drafted === false ? `${href}?outline=1` : href);
      router.refresh();
      return;
    }
    setBusy(false);
    setError(messageFor(r.data.error));
  }

  const option = (value: Choice, title: string, line?: string) => (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
        choice === value ? "border-neutral-900 dark:border-white" : "border-neutral-300 dark:border-neutral-700"
      }`}
    >
      <input type="radio" name="raise-kind" value={value} checked={choice === value} onChange={() => setChoice(value)} className="mt-0.5" disabled={busy} />
      <span>
        <span className="block font-medium">{title}</span>
        {line ? <span className="block text-neutral-500">{line}</span> : null}
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border border-neutral-300 p-4 dark:border-neutral-700">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{LIST_WORDS.legend}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {option("pre_seed", LIST_WORDS.investor, LIST_WORDS.preSeed)}
          {option("seed", LIST_WORDS.investor, LIST_WORDS.seed)}
          {option("lender", LIST_WORDS.lender, LIST_WORDS.lenderLine)}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label htmlFor="raise-brief" className="block text-sm font-medium">
          {LIST_WORDS.brief}
        </label>
        <textarea
          id="raise-brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={1500}
          rows={2}
          disabled={busy}
          placeholder={LIST_WORDS.briefPlaceholder}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {LIST_WORDS.make}
        </button>
        {busy ? (
          <p role="status" className="text-sm text-neutral-500">
            {LIST_WORDS.busy}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
