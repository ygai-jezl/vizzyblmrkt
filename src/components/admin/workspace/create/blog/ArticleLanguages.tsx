"use client";

import { useCallback, useEffect, useState } from "react";
import type { ArticleTabState, ArticleTranslationsView, ArticleVersionView } from "@/lib/i18n/articleTranslations";
import { hreflangOf, languageTagsFor, type TaggedVersion } from "@/lib/content/blog/languageTags";
import { renderArticleHtml } from "@/lib/content/blog/markdown";
import { schemaScriptTag, suggestBlogSchema } from "@/lib/content/blog/schema";
import type { BlogArticleMeta, BlogBrief, ContentNode } from "@/lib/types/contentPlan";
import type { ArticleWords } from "@/lib/types/translation";
import type { ArticleMap } from "@/lib/content/blog/articleMap";

/**
 * An article's versions in other languages (PAGE_LANGUAGES_ENABLED): the canvas loads them once
 * (useArticleTranslations), the node card shows their chips, the inspector a tab per language, and
 * Article › Languages one row per version with its address, copies and Google's language tags.
 */

/** The article's versions, loaded once and again after each action; checked every 20s while one is being made. */
export function useArticleTranslations(workspaceId: string, planId: string, enabled: boolean) {
  const [view, setView] = useState<ArticleTranslationsView | null>(null);
  const url = `/api/admin/workspace/${workspaceId}/content-plans/${planId}/translations`;
  const reload = useCallback(async () => {
    if (!enabled) return;
    const res = await fetch(url).catch(() => null);
    if (res?.ok) setView((await res.json()) as ArticleTranslationsView);
  }, [url, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const busy = view?.versions.some((v) => v.state === "translating" || v.state === "waiting") ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void reload(), 20_000);
    return () => clearInterval(timer);
  }, [busy, reload]);
  const act = useCallback(
    async (body: unknown): Promise<string | null> => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      await reload();
      if (res?.ok) return null;
      const error = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
      return ERRORS[error] ?? "That didn't work. Try again.";
    },
    [url, reload],
  );
  return { view: enabled ? view : null, reload, act };
}

export type ArticleLanguagesHandle = ReturnType<typeof useArticleTranslations> & { view: ArticleTranslationsView };

const ERRORS: Record<string, string> = {
  changed: "This changed since you opened it, so it has been loaded again.",
  out_of_date: "The article changed since this was made. Approve the article, and an update is made.",
  article_not_approved: "Approve the article first.",
  links_changed: "Keep every link the article has.",
  empty: "The title and the article can't be empty.",
  invalid_address: "Use the full https address of the page.",
  not_included: "Translations aren't included for your brand.",
  rate_limited: "Too many requests. Try again in a minute.",
  forbidden: "Only an admin can do this.",
};

const STATE_WORDS: Record<ArticleTabState, string> = {
  approved: "Approved",
  to_check: "Draft, check it",
  translating: "Translating",
  waiting: "Translating",
  changed: "Out of date",
  out_of_date: "Out of date",
  failed: "Failed",
  not_made: "Not made",
};

/** The chips on the article's card: each language and where it is. */
export function languageChips(view: ArticleTranslationsView): Array<{ code: string; label: string; done: boolean }> {
  return [
    { code: view.base.code, label: `${view.base.code.toUpperCase()} ✓`, done: true },
    ...view.versions
      .filter((v) => v.state !== "not_made")
      .map((v) => ({ code: v.lang, label: `${v.lang.toUpperCase()}${v.state === "approved" ? " ✓" : v.state === "to_check" ? " draft" : ""}`, done: v.state === "approved" })),
  ];
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The versions Google's tags list: approved, with an address. */
function tagged(view: ArticleTranslationsView): { base: TaggedVersion | null; versions: TaggedVersion[] } {
  const base = view.base.address ? { lang: view.base.code, url: view.base.address } : null;
  return { base, versions: view.versions.filter((v) => v.approved && v.address).map((v) => ({ lang: v.lang, url: v.address! })) };
}

interface ExportBits {
  node: ContentNode;
  brief: BlogBrief;
  brandName: string;
  logoUrl: string | null;
  map: ArticleMap | null;
}

/** The meta a version's schema reads: the article's, with the version's title, description and alt text. */
function versionMeta(meta: BlogArticleMeta | null | undefined, words: ArticleWords): BlogArticleMeta | null {
  if (!meta) return null;
  return { ...meta, metaTitle: words.metaTitle, metaDescription: words.metaDescription, ...(meta.hero ? { hero: { ...meta.hero, alt: words.heroAlt } } : {}) };
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [done, setDone] = useState<null | "ok" | "failed">(null);
  return (
    <button
      type="button"
      onClick={async () => setDone((await copy(text())) ? "ok" : "failed")}
      className="rounded-md border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      {done === "ok" ? "Copied" : done === "failed" ? "Couldn't copy" : label}
    </button>
  );
}

function VersionRow({ v, view, bits, act, canAct }: { v: ArticleVersionView; view: ArticleTranslationsView; bits: ExportBits; act: ArticleLanguagesHandle["act"]; canAct: boolean }) {
  const [address, setAddress] = useState(v.address ?? "");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setAddress(v.address ?? ""), [v.address]);
  const words = v.approved?.fields ?? null;
  const { base, versions } = tagged(view);
  const live = v.live
    ? v.live.missingTags.length
      ? `Live, but its tags miss ${v.live.missingTags.join(", ")}. Google ignores the whole set until they're there.`
      : v.live.fromDefault === false
        ? `Live, but the ${view.base.name} page doesn't list this version yet. Google ignores the whole set until it does.`
        : "✓ Live"
    : v.approved && v.address
      ? "Approved, not live yet"
      : null;
  const make = v.state === "not_made" ? "Make anyway" : v.state === "failed" ? "Try again" : v.state === "out_of_date" ? "Update now" : null;
  return (
    <li className="space-y-1.5 border-t border-neutral-200 pt-2 first:border-t-0 first:pt-0 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {v.name} <span className="font-normal text-neutral-500">· {v.nativeName}</span>
        </span>
        <span className="text-xs text-neutral-500">
          {STATE_WORDS[v.state]}
          {v.readers !== null ? ` · ${v.readers.toLocaleString()} readers` : ""}
        </span>
      </div>
      {v.state === "failed" && v.failReason ? <p className="text-xs text-red-700 dark:text-red-400">{v.failReason}</p> : null}
      {v.address || v.folder || v.state !== "not_made" ? (
        <div className="flex gap-2">
          <input
            type="url"
            value={address}
            disabled={!canAct || v.rev === null}
            placeholder="https://yourbrand.com/fr/blog/your-article"
            onChange={(e) => setAddress(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
          />
          {canAct && v.rev !== null && address.trim() !== (v.address ?? "") ? (
            <button type="button" onClick={async () => setNote(await act({ action: "address", id: v.id, address: address.trim() }))} className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
              Save
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-neutral-500">
          No address set. Add {v.name}&apos;s folder in <a href="/admin/account/settings" className="underline">Settings › Languages</a>.
        </p>
      )}
      {live ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{live}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {words && v.address && base ? (
          <>
            <CopyButton label="Copy HTML" text={() => renderArticleHtml(words.body)} />
            <CopyButton label="Copy Markdown" text={() => words.body} />
            <CopyButton
              label="Copy schema"
              text={() => {
                const s = suggestBlogSchema({ markdown: words.body, meta: versionMeta(bits.node.blog, words), brief: bits.brief, pageUrl: v.address, brandName: bits.brandName, logoUrl: bits.logoUrl, map: bits.map, inLanguage: hreflangOf(v.lang) });
                return s.jsonLd ? schemaScriptTag(s.jsonLd) : "";
              }}
            />
            <CopyButton label="Copy language tags" text={() => languageTagsFor({ lang: v.lang, url: v.address! }, base, versions)} />
          </>
        ) : null}
        {canAct && view.allowed && make && view.approved ? (
          <button type="button" onClick={async () => setNote(await act({ action: "make", lang: v.lang }))} className="rounded-md border border-neutral-300 px-2 py-1 text-[11px] dark:border-neutral-700">
            {make}
          </button>
        ) : null}
      </div>
      {note ? <p role="status" className="text-xs text-red-700 dark:text-red-400">{note}</p> : null}
    </li>
  );
}

/** Article › Languages: the default and each version, Google's language tags and checklist. */
export function ArticleLanguagesCard({ handle, bits, canAct }: { handle: ArticleLanguagesHandle; bits: ExportBits; canAct: boolean }) {
  const { view } = handle;
  const { base, versions } = tagged(view);
  const approved = view.versions.filter((v) => v.approved);
  const live = view.versions.filter((v) => v.live);
  const checks: Array<[boolean, string]> = [
    [approved.length > 0 && approved.every((v) => Boolean(v.address)), "Each language has its own address"],
    [Boolean(base), "Each version lists itself and every other version"],
    [Boolean(base), `${view.base.name} for everyone else (x-default)`],
    [approved.length > 0, "The whole page is translated: title, description, FAQ, schema, alt text"],
    [approved.length > 0, "A person approves it before it goes live"],
  ];
  return (
    <section aria-label="Languages" className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs font-semibold">Languages</p>
      <ul className="space-y-2">
        <li className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{view.base.name} · first</span>
          <span className="truncate text-xs text-neutral-500">{view.base.address ?? "No article address yet"}</span>
        </li>
        {view.versions.map((v) => (
          <VersionRow key={v.lang} v={v} view={view} bits={bits} act={handle.act} canAct={canAct} />
        ))}
      </ul>
      {base && versions.length ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">Language tags</p>
          <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-[11px] dark:bg-neutral-900">{languageTagsFor(base, base, versions)}</pre>
          <div className="flex items-center gap-2">
            <CopyButton label="Copy language tags" text={() => languageTagsFor(base, base, versions)} />
            <span className="text-[11px] text-neutral-500">Paste these into each version&apos;s head. Each row&apos;s own Copy language tags points its canonical at itself.</span>
          </div>
        </div>
      ) : null}
      <div className="space-y-0.5">
        <p className="text-xs font-medium">Google&apos;s rules for languages</p>
        <ul className="space-y-0.5 text-xs">
          {checks.map(([done, text]) => (
            <li key={text} className={done ? "" : "text-neutral-500"}>
              {done ? "✓" : "◌"} {text}
            </li>
          ))}
          <li className={live.length && live.every((v) => !v.live!.missingTags.length) ? "" : "text-neutral-500"}>
            {live.length ? "✓" : "◌"} Live check: {live.length ? `${live.map((v) => v.name).join(", ")} found` : "no version found live yet"}. A missing return link makes Google ignore the whole set.
          </li>
        </ul>
        <p className="text-[11px] text-neutral-500">Don&apos;t redirect by browser language or location. Link the versions to each other instead.</p>
      </div>
    </section>
  );
}

/** One version in the inspector: its words to check, edit and approve, or what it is waiting for. */
export function ArticleTranslationPanel({ v, handle, canAct }: { v: ArticleVersionView; handle: ArticleLanguagesHandle; canAct: boolean }) {
  const { view } = handle;
  const shown = v.draft?.fields ?? v.approved?.fields ?? null;
  const [words, setWords] = useState<ArticleWords | null>(shown);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => setWords(v.draft?.fields ?? v.approved?.fields ?? null), [v.id, v.rev, v.draft, v.approved]);
  const edited = Boolean(words && shown && JSON.stringify(words) !== JSON.stringify(shown));
  const editable = canAct && Boolean(words) && (v.state === "to_check" || v.state === "approved");
  const toCheck = Object.fromEntries(view.versions.filter((x) => x.state === "to_check" && x.rev !== null).map((x) => [x.id, x.rev!]));
  const status: Record<ArticleTabState, string> = {
    to_check: `Check this ${v.name} version, then approve it. Until you do, it isn't ready to copy for your site.`,
    waiting: "Translating. This takes a minute or two.",
    translating: "Translating. This takes a minute or two.",
    approved: `Approved. Copy it for your site from Article › Languages.`,
    changed: `You changed the ${view.base.name} article. This updates when you approve it.`,
    out_of_date: `The ${view.base.name} article changed. An update is on its way, and this version stays as approved until you approve the update.`,
    failed: `This translation failed: ${v.failReason ?? "no reason was given"}`,
    not_made: `${v.name} has ${v.readers ?? 0} readers${v.folder ? "" : " and no site folder"}, so it isn't made. Press Make anyway to make it.`,
  };
  const run = async (body: unknown) => setNote(await handle.act(body));
  const field = (label: string, key: keyof ArticleWords, rows = 1) => (
    <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
      {label}
      {rows > 1 ? (
        <textarea value={words![key]} disabled={!editable} onChange={(e) => setWords({ ...words!, [key]: e.target.value })} rows={rows} className="mt-1 w-full rounded-md border border-neutral-300 p-2 font-mono text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900" />
      ) : (
        <input value={words![key]} disabled={!editable} onChange={(e) => setWords({ ...words!, [key]: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900" />
      )}
    </label>
  );
  const make = v.state === "not_made" ? "Make anyway" : v.state === "failed" ? "Try again" : v.state === "out_of_date" ? "Update now" : null;
  return (
    <div className="space-y-3">
      <p className="text-sm">{status[v.state]}</p>
      {words ? (
        <>
          {field("Title", "metaTitle")}
          {field("Description", "metaDescription")}
          {words.heroAlt || shown?.heroAlt ? field("Hero alt text", "heroAlt") : null}
          {field("Article", "body", 16)}
          <p className="text-xs text-neutral-500">Kept exactly: links, boxes and sections. Generate and Regenerate change the {view.base.name} article only.</p>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canAct && edited && v.rev !== null ? (
          <button type="button" onClick={() => void run({ action: "save", id: v.id, rev: v.rev, fields: words })} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900">
            Save
          </button>
        ) : null}
        {canAct && !edited && v.state === "to_check" && v.rev !== null ? (
          <>
            <button type="button" onClick={() => void run({ action: "approve", id: v.id, rev: v.rev })} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
              Approve {v.name}
            </button>
            <button type="button" onClick={() => void run({ action: "approve_all", revs: toCheck })} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
              Approve all languages
            </button>
          </>
        ) : null}
        {canAct && view.allowed && view.approved && make ? (
          <button type="button" onClick={() => void run({ action: "make", lang: v.lang })} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            {make}
          </button>
        ) : null}
        {words ? (
          <button type="button" onClick={() => setPreview(!preview)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            {preview ? "Hide preview" : `Preview in ${v.name}`}
          </button>
        ) : null}
      </div>
      {preview && words ? (
        <iframe title={`Preview in ${v.name}`} sandbox="" lang={v.lang} srcDoc={renderArticleHtml(words.body)} className="h-[480px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800" />
      ) : null}
      {note ? <p role="status" className="text-xs text-red-700 dark:text-red-400">{note}</p> : null}
    </div>
  );
}
