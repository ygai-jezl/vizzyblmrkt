"use client";

import { useCallback, useEffect, useState } from "react";
import type { LaunchTabState, LaunchTranslationsView, LaunchVersionView } from "@/lib/i18n/launchTranslations";
import type { LaunchWords } from "@/lib/types/translation";
import { LanguageStrip } from "./lifecycle/LanguageTabs";

/**
 * A launch page's own words in other languages (PAGE_LANGUAGES_ENABLED), in its Strategy settings:
 * a tab per language to check, edit and approve. Once approved, the launch's page at
 * /waitlist/<id>/<lang> shows them; until then, its own words.
 */

const ERRORS: Record<string, string> = {
  changed: "This changed since you opened it, so it has been loaded again.",
  out_of_date: "The page's words changed since this was made. Save the launch, and an update is made.",
  shape_changed: "Keep every question, answer and merge token.",
  empty: "The heading can't be empty.",
  not_included: "Translations aren't included for your brand.",
  rate_limited: "Too many requests. Try again in a minute.",
  forbidden: "Only an admin can do this.",
};

const STATUS: Record<LaunchTabState, (name: string, base: string) => string> = {
  to_check: (name) => `Check the page's words in ${name}, then approve them. Until you do, its ${name} page shows your own words.`,
  translating: () => "Translating. This takes a minute or two.",
  approved: (name) => `Approved. The ${name} page shows these words.`,
  changed: (_name, base) => `You changed the page's ${base} words. Save the launch, and an update is made.`,
  failed: () => "This translation failed.",
  not_made: () => "Not made yet. Save the launch to make it.",
};

export function LaunchLanguages({ campaignId, canAct }: { campaignId: string; canAct: boolean }) {
  const url = `/api/admin/campaigns/${campaignId}/translations`;
  const [view, setView] = useState<LaunchTranslationsView | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) setView((await res.json()) as LaunchTranslationsView);
  }, [url]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const busy = view?.versions.some((v) => v.state === "translating") ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void reload(), 20_000);
    return () => clearInterval(timer);
  }, [busy, reload]);
  if (!view || !view.versions.length) return null;
  const selected = (lang && view.versions.find((v) => v.lang === lang)) || null;
  const act = async (body: unknown): Promise<string | null> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    await reload();
    if (res?.ok) return null;
    const error = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
    return ERRORS[error] ?? "That didn't work. Try again.";
  };
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Your page in other languages</p>
      <LanguageStrip baseName={view.base.nativeName} tabs={view.versions} names={Object.fromEntries(view.versions.map((v) => [v.lang, v.nativeName]))} selected={selected ? lang : null} onSelect={setLang} />
      {selected ? <LaunchPanel key={`${selected.id}:${selected.rev}`} v={selected} view={view} canAct={canAct} act={act} /> : <p className="text-xs text-neutral-500">Each language has its own page address. Pick a language to check its words.</p>}
    </div>
  );
}

function LaunchPanel({ v, view, canAct, act }: { v: LaunchVersionView; view: LaunchTranslationsView; canAct: boolean; act: (body: unknown) => Promise<string | null> }) {
  const shown = v.draft?.fields ?? v.approved?.fields ?? null;
  const [words, setWords] = useState<LaunchWords | null>(shown);
  const [note, setNote] = useState<string | null>(null);
  const edited = Boolean(words && shown && JSON.stringify(words) !== JSON.stringify(shown));
  const editable = canAct && Boolean(words) && (v.state === "to_check" || v.state === "approved");
  const run = async (body: unknown) => setNote(await act(body));
  const toCheck = Object.fromEntries(view.versions.filter((x) => x.state === "to_check" && x.rev !== null).map((x) => [x.id, x.rev!]));
  const input = (label: string, value: string | null, set: (s: string) => void) =>
    value === null ? null : (
      <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}
        <input value={value} disabled={!editable} onChange={(e) => set(e.target.value)} className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900" />
      </label>
    );
  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-sm">{STATUS[v.state](v.name, view.base.name)}</p>
      {v.state === "failed" && v.failReason ? <p className="text-xs text-red-700 dark:text-red-400">{v.failReason}</p> : null}
      {words ? (
        <div className="space-y-2">
          {input("Heading", words.waitlistName, (s) => setWords({ ...words, waitlistName: s }))}
          {input("Line once they've joined", words.statusDescription, (s) => setWords({ ...words, statusDescription: s }))}
          {input("Join button", words.joinButtonLabel, (s) => setWords({ ...words, joinButtonLabel: s }))}
          {input("Voice chat introduction", words.introLine, (s) => setWords({ ...words, introLine: s }))}
          {words.questions.map((q, i) => (
            <div key={i} className="space-y-1">
              {input(`Question ${i + 1}`, q.question, (s) => setWords({ ...words, questions: words.questions.map((x, j) => (j === i ? { ...x, question: s } : x)) }))}
              {(q.answers ?? []).map((a, k) => (
                <div key={k} className="pl-4">
                  {input(`Answer ${k + 1}`, a, (s) =>
                    setWords({ ...words, questions: words.questions.map((x, j) => (j === i ? { ...x, answers: (x.answers ?? []).map((y, m) => (m === k ? s : y)) } : x)) }),
                  )}
                </div>
              ))}
            </div>
          ))}
          <p className="text-xs text-neutral-500">Answers are saved in {view.base.name}, whichever page a person signs up on, so they stay comparable.</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canAct && edited && v.rev !== null ? (
          <button type="button" onClick={() => void run({ action: "save", id: v.id, rev: v.rev, fields: words })} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900">
            Save
          </button>
        ) : null}
        {canAct && !edited && v.state === "to_check" && v.rev !== null ? (
          <>
            <button type="button" onClick={() => void run({ action: "approve", id: v.id, rev: v.rev })} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">
              Approve {v.name}
            </button>
            <button type="button" onClick={() => void run({ action: "approve_all", revs: toCheck })} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
              Approve all languages
            </button>
          </>
        ) : null}
        {canAct && view.allowed && (v.state === "failed" || v.state === "not_made") ? (
          <button type="button" onClick={() => void run({ action: "make", lang: v.lang })} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            {v.state === "failed" ? "Try again" : "Make it"}
          </button>
        ) : null}
      </div>
      {note ? <p role="status" className="text-xs text-red-700 dark:text-red-400">{note}</p> : null}
    </div>
  );
}
