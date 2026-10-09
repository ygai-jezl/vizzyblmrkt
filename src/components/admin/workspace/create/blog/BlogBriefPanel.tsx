"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  BlogEntityRelation,
  BlogIntent,
  BlogLinkIntent,
  CONTENT_PLAN_LIMITS,
  type BlogBrief,
  type BlogEntity,
  type BlogLink,
  type BlogQuestion,
  type BlogSource,
} from "@/lib/types/contentPlan";
import { hostOf, normalizeUrl } from "@/lib/content/blog/brief";
import type { BlogHubControls } from "./types";

/**
 * The blog hub's brief, editable: the question the article answers, what buyers ask, and
 * the lists research fills in — questions, pages to link to, sources to cite, entities.
 * The pages and sources are ALLOW-lists (the writer may link and cite only what is here),
 * so the operator can read exactly what the article is allowed to lean on, and correct it,
 * before a word is written.
 *
 * The canvas owns the brief and sends it with every save, so each edit hands back a whole
 * new one — and never one the plan's schema would refuse (a link that isn't https, a
 * half-typed site address, a row past the cap), because that would fail the whole save.
 */

const LABEL_TEXT = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
const LABEL = `block ${LABEL_TEXT}`;
const HINT = "text-[11px] text-neutral-500 dark:text-neutral-400";
const ERROR = "text-xs text-red-600 dark:text-red-400";
const FIELD =
  "rounded-md border border-neutral-300 px-2 py-1.5 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const INPUT = `${FIELD} text-xs`;
const SELECT =
  "max-w-full rounded-md border border-neutral-300 px-1.5 py-1 text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const SMALL_BUTTON =
  "rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const REMOVE =
  "shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

const INTENT_LABEL: Record<BlogIntent, string> = {
  definition: "What it is",
  how_to: "How to do it",
  alternatives: "Alternatives",
  comparison: "Comparison",
  integrations: "Integrations",
  use_cases: "Use cases",
  pricing: "Pricing",
  limits: "Limits",
  benchmarks: "Benchmarks",
  other: "Related",
};

const LINK_INTENT_LABEL: Record<BlogLinkIntent, string> = {
  convert: "Converts (pricing, demo, sign-up)",
  product: "Product",
  proof: "Customer proof",
  compare: "Comparison",
  learn: "Goes deeper",
};

const RELATION_LABEL: Record<BlogEntityRelation, string> = {
  brand: "Brand",
  product: "Product",
  category: "Category",
  alternative: "Alternative",
  integration: "Integration",
  audience: "Audience",
  use_case: "Use case",
};

const SOURCE_STATUS: Record<BlogSource["status"], { label: string; cls: string }> = {
  verified: {
    label: "Checked on the page",
    cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  },
  unverified: {
    label: "Not confirmed — check it",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  operator: {
    label: "Added by you",
    cls: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  },
};

/** A source research found: the brand's own cite sources and the web are two places it
 *  looks, and once the list holds both, each row says which it came from. */
function sourceBadge(s: BlogSource, mixed: boolean): { label: string; cls: string } {
  if (s.status === "verified" && s.origin === "cited") {
    return { label: "From your cite sources", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" };
  }
  if (s.status === "verified" && mixed) return { ...SOURCE_STATUS.verified, label: "From the web · checked on the page" };
  return SOURCE_STATUS[s.status];
}

/** The only kind of link the brief stores, and the only kind shown as a link (the plan
 *  schema's own rule) — plus a host, so the row has something to be called. */
const HTTPS_URL = /^https:\/\/[^\s<>"']+$/i;
const isHttpsUrl = (url: string) => HTTPS_URL.test(url) && hostOf(url) !== "";
const NOT_HTTPS = "Use a full link that starts with https://";
const DUPLICATE = "That's already in the list.";

/** The same entry, give or take capitals and spacing. */
const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function removeAt<T>(rows: T[], index: number): T[] {
  return rows.filter((_, i) => i !== index);
}

function replaceAt<T>(rows: T[], index: number, row: T): T[] {
  return rows.map((r, i) => (i === index ? row : r));
}

/** Enter adds the row — the inspector is not a form, so there is nothing to submit. */
function onEnter(run: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    run();
  };
}

/** One list, folded away. Its summary carries the count, so the panel reads at a glance
 *  while it stays short. */
function Section({ summary, hint, children }: { summary: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <details className="py-2 last:pb-0">
      {/* Not `block`: that would take the disclosure triangle away. */}
      <summary className={`cursor-pointer ${LABEL_TEXT}`}>{summary}</summary>
      <div className="mt-2 space-y-2">
        {hint ? <p className={HINT}>{hint}</p> : null}
        {children}
      </div>
    </details>
  );
}

function AtTheCap({ max }: { max: number }) {
  return <p className={HINT}>Up to {max} — remove one to add another.</p>;
}

/** Why a row was not added — said next to the row, and read out. */
function Refused({ why }: { why: string | null }) {
  return why ? (
    <p role="alert" className={ERROR}>
      {why}
    </p>
  ) : null;
}

function RemoveButton({ what, onClick }: { what: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={`Remove ${what}`} onClick={onClick} className={REMOVE}>
      ✕
    </button>
  );
}

/** A brief's URL, small and clickable — and a link only when it is https. */
function UrlLink({ url }: { url: string }) {
  const cls = "block truncate text-[11px]";
  return HTTPS_URL.test(url) ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className={`${cls} text-blue-600 hover:underline dark:text-blue-400`}
    >
      {url}
    </a>
  ) : (
    <span title={url} className={`${cls} text-neutral-500 dark:text-neutral-400`}>
      {url}
    </span>
  );
}

function Questions({ rows, onChange }: { rows: BlogQuestion[]; onChange: (next: BlogQuestion[]) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const question = text.trim();
    if (!question) return;
    if (rows.some((r) => fold(r.question) === fold(question))) {
      setError(DUPLICATE);
      return;
    }
    onChange([...rows, { question, intent: "other", by: "operator" }]);
    setText("");
    setError(null);
  }

  // A row the operator changes becomes theirs, so researching again keeps the change
  // (research only ever replaces its own rows).
  function setIntent(index: number, row: BlogQuestion, intent: BlogIntent) {
    onChange(replaceAt(rows, index, { ...row, intent, by: "operator" }));
  }

  return (
    <>
      {rows.length ? (
        <ul className="space-y-1.5">
          {rows.map((q, i) => (
            <li key={`${i}-${q.question}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-[12rem] flex-1 text-xs">{q.question}</span>
              <select
                aria-label={`Kind of question: ${q.question}`}
                value={q.intent}
                onChange={(e) => setIntent(i, q, e.target.value as BlogIntent)}
                className={SELECT}
              >
                {BlogIntent.options.map((id) => (
                  <option key={id} value={id}>
                    {INTENT_LABEL[id]}
                  </option>
                ))}
              </select>
              <RemoveButton what={`question: ${q.question}`} onClick={() => onChange(removeAt(rows, i))} />
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length >= CONTENT_PLAN_LIMITS.MAX_BLOG_QUESTIONS ? (
        <AtTheCap max={CONTENT_PLAN_LIMITS.MAX_BLOG_QUESTIONS} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="A question to add"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter(add)}
            maxLength={300}
            placeholder="A question buyers ask next"
            className={`min-w-[12rem] flex-1 ${INPUT}`}
          />
          <button type="button" onClick={add} disabled={!text.trim()} className={SMALL_BUTTON}>
            Add
          </button>
        </div>
      )}
      <Refused why={error} />
    </>
  );
}

function Links({ rows, onChange }: { rows: BlogLink[]; onChange: (next: BlogLink[]) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const link = url.trim();
    if (!link) return;
    if (!isHttpsUrl(link)) {
      setError(NOT_HTTPS);
      return;
    }
    if (rows.some((r) => normalizeUrl(r.url) === normalizeUrl(link))) {
      setError(DUPLICATE);
      return;
    }
    onChange([...rows, { url: link, label: label.trim(), intent: "learn", by: "operator" }]);
    setUrl("");
    setLabel("");
    setError(null);
  }

  // As with a question: a row the operator changes becomes theirs and survives research.
  function setIntent(index: number, row: BlogLink, intent: BlogLinkIntent) {
    onChange(replaceAt(rows, index, { ...row, intent, by: "operator" }));
  }

  return (
    <>
      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((l, i) => {
            const name = l.label.trim() || hostOf(l.url) || l.url;
            return (
              <li key={`${i}-${l.url}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <div className="min-w-[12rem] flex-1">
                  <div className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">{name}</div>
                  <UrlLink url={l.url} />
                </div>
                <select
                  aria-label={`What ${name} is for`}
                  value={l.intent}
                  onChange={(e) => setIntent(i, l, e.target.value as BlogLinkIntent)}
                  className={SELECT}
                >
                  {BlogLinkIntent.options.map((id) => (
                    <option key={id} value={id}>
                      {LINK_INTENT_LABEL[id]}
                    </option>
                  ))}
                </select>
                <RemoveButton what={`page: ${name}`} onClick={() => onChange(removeAt(rows, i))} />
              </li>
            );
          })}
        </ul>
      ) : null}
      {rows.length >= CONTENT_PLAN_LIMITS.MAX_BLOG_LINKS ? (
        <AtTheCap max={CONTENT_PLAN_LIMITS.MAX_BLOG_LINKS} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Link to a page to add"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter(add)}
            maxLength={2000}
            placeholder="https://example.com/pricing"
            className={`min-w-[12rem] flex-1 ${INPUT}`}
          />
          <input
            aria-label="What the page is"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={onEnter(add)}
            maxLength={160}
            placeholder="What the page is"
            className={`min-w-[8rem] flex-1 ${INPUT}`}
          />
          <button type="button" onClick={add} disabled={!url.trim()} className={SMALL_BUTTON}>
            Add
          </button>
        </div>
      )}
      <Refused why={error} />
    </>
  );
}

function Sources({
  rows,
  onChange,
  onKeep,
}: {
  rows: BlogSource[];
  onChange: (next: BlogSource[]) => void;
  onKeep?: (url: string) => Promise<"kept" | "failed">;
}) {
  const [url, setUrl] = useState("");
  const [fact, setFact] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which pages have been kept as cite sources this visit (or are being, or couldn't be).
  const [keeping, setKeeping] = useState<Record<string, "saving" | "kept" | "failed">>({});
  const mixed = rows.some((r) => r.origin === "cited");

  async function keep(link: string) {
    if (!onKeep) return;
    const key = normalizeUrl(link);
    setKeeping((k) => ({ ...k, [key]: "saving" }));
    const result = await onKeep(link).catch(() => "failed" as const);
    setKeeping((k) => ({ ...k, [key]: result }));
  }

  function add() {
    const link = url.trim();
    const says = fact.trim();
    if (!link && !says) return;
    if (!isHttpsUrl(link)) {
      setError(NOT_HTTPS);
      return;
    }
    // A source with no fact is never given to the writer, so it would sit here unused.
    if (!says) {
      setError("Add the fact this source supports.");
      return;
    }
    if (rows.some((r) => normalizeUrl(r.url) === normalizeUrl(link) && fold(r.fact) === fold(says))) {
      setError(DUPLICATE);
      return;
    }
    onChange([
      ...rows,
      { url: link, title: "", publisher: hostOf(link).slice(0, 120), year: null, fact: says, status: "operator" },
    ]);
    setUrl("");
    setFact("");
    setError(null);
  }

  return (
    <>
      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((s, i) => {
            const name = s.publisher.trim() || hostOf(s.url) || s.url;
            const badge = sourceBadge(s, mixed);
            // A source a web search turned up, or one typed in by hand, can be kept for
            // every later article. One from the cite sources already is.
            const kept = keeping[normalizeUrl(s.url)];
            const keepable = Boolean(onKeep) && s.origin !== "cited" && s.status !== "unverified" && isHttpsUrl(s.url);
            return (
              <li
                key={`${i}-${s.url}`}
                className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">
                    {name}
                    {s.year ? `, ${s.year}` : ""}
                  </span>
                  <RemoveButton what={`source: ${name}`} onClick={() => onChange(removeAt(rows, i))} />
                </div>
                {s.fact ? <p className="text-xs leading-snug text-neutral-700 dark:text-neutral-300">{s.fact}</p> : null}
                <UrlLink url={s.url} />
                {s.status === "unverified" ? (
                  <button
                    type="button"
                    onClick={() => onChange(replaceAt(rows, i, { ...s, status: "operator" }))}
                    className={SMALL_BUTTON}
                  >
                    I&apos;ve checked it
                  </button>
                ) : null}
                {keepable ? (
                  kept === "kept" ? (
                    <p role="status" className={HINT}>
                      Kept as a cite source — it is being read now, and later articles can draw on it.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void keep(s.url)}
                        disabled={kept === "saving"}
                        title="Add this page to your cite sources, so every later article can draw on it"
                        className={SMALL_BUTTON}
                      >
                        {kept === "saving" ? "Keeping…" : "Keep as a cite source"}
                      </button>
                      {kept === "failed" ? (
                        <span role="alert" className={ERROR}>
                          Couldn&apos;t keep it — try again.
                        </span>
                      ) : null}
                    </div>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {rows.length >= CONTENT_PLAN_LIMITS.MAX_BLOG_SOURCES ? (
        <AtTheCap max={CONTENT_PLAN_LIMITS.MAX_BLOG_SOURCES} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Link to a source to add"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter(add)}
            maxLength={2000}
            placeholder="https://example.org/report"
            className={`min-w-[12rem] flex-1 ${INPUT}`}
          />
          <input
            aria-label="The fact it supports"
            value={fact}
            onChange={(e) => {
              setFact(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter(add)}
            maxLength={600}
            placeholder="The fact it supports"
            className={`min-w-[12rem] flex-1 ${INPUT}`}
          />
          <button type="button" onClick={add} disabled={!url.trim() && !fact.trim()} className={SMALL_BUTTON}>
            Add
          </button>
        </div>
      )}
      <Refused why={error} />
    </>
  );
}

function Entities({ rows, onChange }: { rows: BlogEntity[]; onChange: (next: BlogEntity[]) => void }) {
  const [name, setName] = useState("");
  // No default: the article states the relation as fact ("X is an alternative to Y"), so
  // it has to be chosen, not left on whatever came first.
  const [relation, setRelation] = useState<BlogEntityRelation | "">("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const entity = name.trim();
    if (!entity) return;
    if (!relation) {
      setError("Choose how it relates to your brand.");
      return;
    }
    if (rows.some((r) => fold(r.name) === fold(entity))) {
      setError(DUPLICATE);
      return;
    }
    onChange([...rows, { name: entity, relation, by: "operator" }]);
    setName("");
    setRelation("");
    setError(null);
  }

  return (
    <>
      {rows.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {rows.map((e, i) => (
            <li
              key={`${i}-${e.name}`}
              className="flex max-w-full items-center gap-1 rounded-full border border-neutral-300 py-0.5 pl-2.5 pr-1 text-[11px] dark:border-neutral-700"
            >
              <span className="min-w-0 truncate">
                {e.name} <span className="text-neutral-500 dark:text-neutral-400">· {RELATION_LABEL[e.relation].toLowerCase()}</span>
              </span>
              <RemoveButton what={e.name} onClick={() => onChange(removeAt(rows, i))} />
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length >= CONTENT_PLAN_LIMITS.MAX_BLOG_ENTITIES ? (
        <AtTheCap max={CONTENT_PLAN_LIMITS.MAX_BLOG_ENTITIES} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Name to add"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter(add)}
            maxLength={120}
            placeholder="A product, category or company"
            className={`min-w-[12rem] flex-1 ${INPUT}`}
          />
          <select
            aria-label="How it relates to your brand"
            value={relation}
            onChange={(e) => {
              setRelation(e.target.value as BlogEntityRelation | "");
              setError(null);
            }}
            className={SELECT}
          >
            <option value="">How it relates…</option>
            {BlogEntityRelation.options.map((id) => (
              <option key={id} value={id}>
                {RELATION_LABEL[id]}
              </option>
            ))}
          </select>
          <button type="button" onClick={add} disabled={!name.trim() || !relation} className={SMALL_BUTTON}>
            Add
          </button>
        </div>
      )}
      <Refused why={error} />
    </>
  );
}

function Publisher({
  brief,
  brandName,
  set,
}: {
  brief: BlogBrief;
  brandName: string;
  set: (patch: Partial<BlogBrief>) => void;
}) {
  // A site address is typed a character at a time, and most of those are not a link yet.
  // What is typed is kept here; the brief is only handed a whole https link, or none.
  const [site, setSite] = useState(brief.publisherUrl);
  const [held, setHeld] = useState(brief.publisherUrl);
  if (held !== brief.publisherUrl) {
    // The brief moved on (research filled the site in, or a valid edit landed) — show it.
    setHeld(brief.publisherUrl);
    setSite(brief.publisherUrl);
  }
  const typed = site.trim();
  const invalid = typed !== "" && !isHttpsUrl(typed);

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={LABEL}>
        Name
        <input
          value={brief.publisherName}
          onChange={(e) => set({ publisherName: e.target.value })}
          maxLength={120}
          placeholder={brandName}
          className={`mt-1 w-full ${INPUT}`}
        />
      </label>
      <label className={LABEL}>
        Site
        <input
          type="url"
          value={site}
          onChange={(e) => {
            setSite(e.target.value);
            const next = e.target.value.trim();
            if (next === "" || isHttpsUrl(next)) set({ publisherUrl: next });
          }}
          maxLength={2000}
          aria-invalid={invalid}
          placeholder="https://example.com"
          className={`mt-1 w-full ${INPUT}`}
        />
      </label>
      {invalid ? (
        <p role="alert" className={`sm:col-span-2 ${ERROR}`}>
          {NOT_HTTPS}, or leave it blank.
        </p>
      ) : null}
      <label className={`sm:col-span-2 ${LABEL}`}>
        Author
        <input
          value={brief.author}
          onChange={(e) => set({ author: e.target.value })}
          maxLength={120}
          placeholder="Leave blank and the brand is the author"
          className={`mt-1 w-full ${INPUT}`}
        />
      </label>
    </div>
  );
}

export function BlogBriefPanel({ controls, disabled }: { controls: BlogHubControls; disabled?: boolean }) {
  const id = useId();
  const { brief, busy } = controls;
  // A note about the fact check belongs beside Check facts, under the copy — not here.
  const note = controls.noteFor === "research" ? controls.note : null;
  // Research hands back a whole new brief, so an edit made while it runs would be lost;
  // one made while the article is written or checked would not be in what they read. So
  // the panel waits while anything runs.
  const locked = Boolean(disabled) || busy !== null;
  const set = (patch: Partial<BlogBrief>) => controls.onBriefChange({ ...brief, ...patch });
  const toCheck = brief.sources.filter((s) => s.status === "unverified").length;

  return (
    <fieldset disabled={locked} aria-label="Blog brief" className="min-w-0 space-y-3">
      <label className={LABEL}>
        The question this article answers
        <input
          value={brief.primaryQuestion}
          onChange={(e) => set({ primaryQuestion: e.target.value })}
          maxLength={300}
          placeholder="Worded the way a buyer would ask it"
          className={`mt-1 w-full ${FIELD} text-sm`}
        />
      </label>

      <div>
        <label htmlFor={`${id}-asks`} className={LABEL}>
          What buyers ask
        </label>
        <textarea
          id={`${id}-asks`}
          aria-describedby={`${id}-asks-hint`}
          value={brief.buyerQuestions}
          onChange={(e) => set({ buyerQuestions: e.target.value })}
          rows={3}
          maxLength={6000}
          className={`mt-1 w-full ${INPUT} leading-relaxed`}
        />
        <p id={`${id}-asks-hint`} className={`mt-1 ${HINT}`}>
          Paste anything you know buyers ask — sales calls, support tickets, search data. Used as leads, never
          copied.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => controls.onResearch()}
          disabled={locked}
          title="Find the questions buyers ask, pages to link to and sources to cite"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy === "research" ? "Researching…" : brief.researchedAt ? "Research again" : "Research"}
        </button>
        <span role="status" className="min-w-0 flex-1 text-xs text-neutral-500 dark:text-neutral-400">
          {note}
        </span>
      </div>

      <div className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        <Section
          summary={`Questions to answer · ${brief.questions.length}`}
          hint="What buyers ask next — each one becomes a section of the article."
        >
          <Questions rows={brief.questions} onChange={(questions) => set({ questions })} />
        </Section>
        <Section
          summary={`Pages to link to · ${brief.links.length}`}
          hint="The only pages on your own site the article may link to."
        >
          <Links rows={brief.links} onChange={(links) => set({ links })} />
        </Section>
        <Section
          summary={
            <>
              Sources to cite · {brief.sources.length}
              {toCheck ? <span className="text-amber-700 dark:text-amber-400"> ({toCheck} to check)</span> : null}
            </>
          }
          hint={
            controls.onKeepSource
              ? "The only sources the article may cite: checked facts from your cite sources and from a web search, side by side — neither comes first, and the article uses the ones that fit. One that isn't confirmed is left out until you've checked it."
              : "The only other sites the article may cite. One that isn't confirmed is left out until you've checked it."
          }
        >
          <Sources rows={brief.sources} onChange={(sources) => set({ sources })} onKeep={controls.onKeepSource} />
        </Section>
        <Section
          summary={`Entities · ${brief.entities.length}`}
          hint="The things the article should name, and how each relates to your brand."
        >
          <Entities rows={brief.entities} onChange={(entities) => set({ entities })} />
        </Section>
        <Section
          summary={`Publisher · ${brief.publisherName.trim() || controls.brandName.trim() || "not set"}`}
          hint="Who publishes the article — used in the suggested schema markup."
        >
          <Publisher brief={brief} brandName={controls.brandName} set={set} />
        </Section>
      </div>
    </fieldset>
  );
}
