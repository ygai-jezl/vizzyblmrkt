"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye } from "lucide-react";
import type { EmailLanguage } from "@/lib/email/emailRender";
import type { TabView, TranslationsViewBody } from "@/lib/i18n/translationsAdmin";
import type { EmailWords } from "@/lib/types/translation";
import { api, errorText } from "../connect/api";
import { Badge, Banner, Button, Field, inputClass } from "../connect/ui";

/**
 * A journey's emails in other languages (ASSET_TRANSLATIONS_ENABLED): the "Who gets which version"
 * box on the Content tab, and each email's language tabs. The server works out every tab's state
 * (src/lib/i18n/translationsAdmin.ts); this shows it and sends the four actions.
 */

/** The journey's translations, loaded once and again after each action; checked every 20s while any are on the way. */
export function useTranslations(journeyId: string, enabled: boolean) {
  const [view, setView] = useState<TranslationsViewBody | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const r = await api<TranslationsViewBody>(`/api/admin/lifecycle/journeys/${journeyId}/translations`);
    if (r.ok) setView(r.data);
  }, [journeyId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const busy = view?.emails.some((e) => e.tabs.some((t) => t.state === "translating" || t.state === "waiting")) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void reload(), 20_000);
    return () => clearInterval(timer);
  }, [busy, reload]);
  return { view: enabled ? view : null, reload };
}

const ERRORS: Record<string, string> = {
  changed: "This changed since you opened it, so it has been loaded again.",
  out_of_date: "The published email changed, so this translation is being updated.",
  tokens_changed: "Keep every merge token in double braces as it is.",
  empty: "The subject and the body can't be empty.",
  not_included: "Translations aren't included for your brand.",
  not_published: "Publish the journey first.",
  rate_limited: "Too many requests. Try again in a minute.",
};
const errorOf = (data: unknown) => ERRORS[(data as { error?: string })?.error ?? ""] ?? errorText(data);

async function act(journeyId: string, body: unknown): Promise<{ ok: true } | { ok: false; text: string }> {
  const r = await api(`/api/admin/lifecycle/journeys/${journeyId}/translations`, { method: "POST", body: JSON.stringify(body) });
  return r.ok ? { ok: true } : { ok: false, text: errorOf(r.data) };
}

/** Every translation waiting to be checked, with the rev the person sees: what Approve all languages names. */
export function revsToCheck(view: TranslationsViewBody): Record<string, number> {
  return Object.fromEntries(view.emails.flatMap((e) => e.tabs.filter((t) => t.state === "to_check" && t.rev !== null).map((t) => [t.id, t.rev!])));
}

/** "Who gets which version": the brand's languages, their readers, and who gets the default. */
export function WhoGetsWhich({ journeyId, view, canAct, onChanged }: { journeyId: string; view: TranslationsViewBody; canAct: boolean; onChanged: () => void }) {
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const base = view.base.name;
  const missing = view.emails.some((e) => e.tabs.some((t) => t.state === "waiting"));
  const make = async () => {
    setWorking(true);
    const r = await act(journeyId, { action: "make" });
    setWorking(false);
    setMsg(r.ok ? { tone: "ok", text: "Making the versions. They come back here to check." } : { tone: "err", text: r.text });
    onChanged();
  };
  return (
    <section className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Who gets which version</h3>
        <span className="text-xs text-neutral-500">Across your brand</span>
      </div>
      <ul className="space-y-1 text-sm">
        <li className="flex justify-between gap-3">
          <span>
            {base} {view.baseReaders !== null ? <span className="text-neutral-500">· {view.baseReaders.toLocaleString()} readers</span> : null}
          </span>
          <span className="text-neutral-500">Everyone else gets this</span>
        </li>
        {view.languages.map((l) => (
          <li key={l.code} className="flex justify-between gap-3">
            <span>
              {l.name} <span className="text-neutral-500">· {l.readers.toLocaleString()} readers</span>
            </span>
            <span className={l.ready ? "" : "text-neutral-500"}>{l.ready ? "Gets its own version" : `Gets ${base} until ${view.minReaders} readers`}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">Each person gets the version in their language once you approve it.</p>
      {!view.published ? <p className="text-xs text-neutral-500">Publish the journey to make its translations.</p> : null}
      {canAct && view.allowed && view.published && missing ? (
        <Button disabled={working} onClick={make}>
          Make versions
        </Button>
      ) : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
    </section>
  );
}

/** The tab strip above an email: its default language first, then each other language with its state. */
export function LanguageStrip({ baseName, tabs, names, selected, onSelect }: {
  baseName: string;
  tabs: Array<{ lang: string; state: string }>;
  names: Record<string, string>;
  selected: string | null;
  onSelect: (lang: string | null) => void;
}) {
  const label = (t: { lang: string; state: string }) => {
    const name = names[t.lang] ?? t.lang;
    if (t.state === "approved") return `${name} ✓`;
    if (t.state === "to_check") return `${name} · to check`;
    if (t.state === "translating" || t.state === "waiting") return `${name} · translating`;
    if (t.state === "out_of_date" || t.state === "changed") return `${name} · out of date`;
    if (t.state === "failed") return `${name} · failed`;
    return `${name} · not made`;
  };
  const item = (id: string | null, text: string) => (
    <button
      key={id ?? "base"}
      type="button"
      role="tab"
      aria-selected={selected === id}
      onClick={() => onSelect(id)}
      className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs ${
        selected === id ? "border-neutral-900 font-medium text-neutral-900 dark:border-white dark:text-white" : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800" role="tablist" aria-label="Languages">
      {item(null, `${baseName} ✓`)}
      {tabs.map((t) => item(t.lang, label(t)))}
    </div>
  );
}

/** One email in one other language: its words, what they are waiting for, and what a person can do. */
export function TranslationPanel({
  journeyId,
  tab,
  view,
  base,
  waitlist,
  canAct,
  preview,
  onChanged,
}: {
  journeyId: string;
  tab: TabView;
  view: TranslationsViewBody;
  /** The email's own words, for an email not translated yet. */
  base: EmailWords;
  waitlist: boolean;
  canAct: boolean;
  preview: (words: EmailWords, language: EmailLanguage | null) => { subject: string; html: string };
  onChanged: () => void;
}) {
  const lang = view.languages.find((l) => l.code === tab.lang);
  const name = lang?.name ?? tab.lang;
  const baseName = view.base.name;
  const shown = tab.draft?.fields ?? tab.approved?.fields ?? null;
  const [words, setWords] = useState<EmailWords | null>(shown);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  useEffect(() => setWords(tab.draft?.fields ?? tab.approved?.fields ?? null), [tab.id, tab.rev, tab.draft, tab.approved]);
  const edited = Boolean(words && shown && JSON.stringify(words) !== JSON.stringify(shown));
  const editable = canAct && view.allowed && Boolean(words) && (tab.state === "to_check" || tab.state === "approved");

  const run = async (body: unknown, done: string) => {
    setWorking(true);
    const r = await act(journeyId, body);
    setWorking(false);
    setMsg(r.ok ? { tone: "ok", text: done } : { tone: "err", text: r.text });
    onChanged();
  };
  const approveAll = () => run({ action: "approve_all", revs: revsToCheck(view) }, "Approved every language waiting to be checked.");

  const status: Record<TabView["state"], string> = {
    to_check: `Check this ${name} version, then approve it.`,
    waiting: "Translating. This takes a minute or two.",
    translating: "Translating. This takes a minute or two.",
    approved: `Approved. ${name} readers get this version.`,
    changed: `You changed the ${baseName} email. This updates when you publish.`,
    out_of_date: `The published ${baseName} email changed. An update is on its way, and ${name} readers keep this version until you approve it.`,
    failed: `This translation failed: ${tab.failReason ?? "no reason was given"}`,
    not_made: `${name} has ${lang?.readers ?? 0} readers, under your ${view.minReaders}. They get ${baseName}.`,
    not_translatable: `This email was designed in the layout editor, so it is sent in ${baseName} for now.`,
  };
  const rendered = showPreview && words ? preview(words, view.emailLanguages[tab.lang] ?? null) : null;

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {tab.state === "to_check" ? <Badge tone="amber">to check</Badge> : null} {status[tab.state]}
      </p>
      {words ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Subject">
              <input className={inputClass} value={words.subject} disabled={!editable} onChange={(e) => setWords({ ...words, subject: e.target.value.slice(0, 200) })} />
            </Field>
            {waitlist ? null : (
              <Field label="Preview text">
                <input
                  className={inputClass}
                  value={words.previewText ?? ""}
                  disabled={!editable || !base.previewText}
                  onChange={(e) => setWords({ ...words, previewText: e.target.value.slice(0, 200) || null })}
                />
              </Field>
            )}
          </div>
          <Field label="Body">
            <textarea className={`${inputClass} min-h-40 font-mono text-xs`} value={words.body} disabled={!editable} onChange={(e) => setWords({ ...words, body: e.target.value.slice(0, 20000) })} />
          </Field>
          <p className="text-xs text-neutral-500">Kept exactly: merge tokens and links.</p>
          {!tab.approved ? <p className="text-xs text-neutral-500">{`${name} readers get ${baseName} until you approve this.`}</p> : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canAct && edited && tab.rev !== null ? (
          <Button tone="primary" disabled={working} onClick={() => run({ action: "save", id: tab.id, rev: tab.rev, fields: words }, "Saved. Approve it when it reads right.")}>
            Save
          </Button>
        ) : null}
        {canAct && !edited && tab.state === "to_check" && tab.rev !== null ? (
          <>
            <Button tone="primary" disabled={working} onClick={() => run({ action: "approve", id: tab.id, rev: tab.rev }, `Approved. ${name} readers get this version.`)}>
              Approve
            </Button>
            <Button disabled={working} onClick={approveAll}>
              Approve all languages
            </Button>
          </>
        ) : null}
        {canAct && view.allowed && view.published && (tab.state === "out_of_date" || tab.state === "failed" || tab.state === "not_made") ? (
          <Button disabled={working} onClick={() => run({ action: "make", lang: tab.lang }, "Making it now. It comes back here to check.")}>
            {tab.state === "not_made" ? "Make anyway" : tab.state === "failed" ? "Try again" : "Update now"}
          </Button>
        ) : null}
        {words ? (
          <Button onClick={() => setShowPreview(!showPreview)}>
            <Eye size={14} /> {showPreview ? "Hide preview" : `Preview in ${name}`}
          </Button>
        ) : null}
      </div>
      {rendered ? (
        <div className="space-y-1">
          <p className="text-sm">
            <span className="text-neutral-500">Subject:</span> {rendered.subject}
          </p>
          <iframe title={`Preview in ${name}`} sandbox="" srcDoc={rendered.html} className="h-[480px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800" />
        </div>
      ) : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
    </div>
  );
}
