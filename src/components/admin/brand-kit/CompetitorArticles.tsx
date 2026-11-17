"use client";

import type { ReactNode } from "react";
import { Badge, Banner } from "@/components/admin/connect/ui";
import {
  ARTICLE_PROBLEM_TEXT,
  GOOGLE_ARTICLE_NOTE,
  askLabel,
  formatLabel,
  stageLabel,
  type ArticleTotals,
  type ArticleView,
} from "@/lib/competitors/view";
import { shortDate } from "./CompetitorsPage";

/**
 * Brand › Competitors › one competitor › What they write (COMPETITOR_ARTICLES_ENABLED): each of
 * their articles read in full, newest first. What it covers, who it is for, the numbers it uses
 * (each quote found word for word in the article), who it cites, what it asks the reader to do and
 * which of their pages it sends readers to.
 */

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-words underline decoration-neutral-300 hover:decoration-neutral-600">
      {children}
    </a>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</p>
      <div className="text-sm text-neutral-700 dark:text-neutral-300">{children}</div>
    </div>
  );
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

function Article({ a, subjectNames }: { a: ArticleView; subjectNames: Record<string, string> }) {
  const onMap = a.subjectIds.map((id) => subjectNames[id]).filter(Boolean);
  const theirOwn = a.stats.filter((s) => s.theirOwn).length;
  return (
    <li className="px-4 py-3">
      <details>
        <summary className="cursor-pointer list-none space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{a.title || pathOf(a.url)}</span>
            {a.publishedAt ? <span className="text-xs text-neutral-500">{shortDate(a.publishedAt)}</span> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {a.format ? <Badge>{formatLabel(a.format)}</Badge> : null}
            {a.stage ? <Badge>{stageLabel(a.stage)}</Badge> : null}
            {a.stats.length ? <Badge>{`${a.stats.length} stat${a.stats.length === 1 ? "" : "s"}`}</Badge> : null}
            {[...new Set(a.asks.map((x) => x.kind))].map((k) => (
              <Badge key={k} tone="green">
                {askLabel(k)}
              </Badge>
            ))}
            {a.mentions.you.length ? <Badge tone="amber">Names you</Badge> : null}
            {a.readBy === "google" ? <Badge>Read through Google</Badge> : null}
          </div>
        </summary>

        <div className="mt-3 grid gap-4 border-t border-dashed border-neutral-200 pt-3 sm:grid-cols-2 dark:border-neutral-800">
          <div className="sm:col-span-2">
            <Part title="About">
              <p>{a.summary}</p>
              {a.angle ? (
                <p className="mt-1">
                  <span className="font-medium">Their angle:</span> {a.angle}
                </p>
              ) : null}
              {a.question ? <p className="mt-1 text-neutral-500">It answers: {a.question}</p> : null}
            </Part>
          </div>
          <Part title="Written for">
            {a.reader.roles.length ? <p>{a.reader.roles.join(", ")}</p> : <p className="text-neutral-500">It doesn&rsquo;t say.</p>}
            {a.reader.companies ? <p className="text-neutral-500">{a.reader.companies}</p> : null}
            {a.reader.pains.length ? (
              <ul className="mt-1 list-disc pl-5">
                {a.reader.pains.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </Part>
          <Part title="On your brand map">
            {onMap.length ? <p>{onMap.join(" · ")}</p> : a.newTopic ? <p>Not on your map: {a.newTopic}</p> : <p className="text-neutral-500">No subject matched.</p>}
            {a.mentions.you.length ? <p className="mt-1">Names you: {a.mentions.you.join(", ")}</p> : null}
            {a.mentions.others.length ? <p className="mt-1">Also names: {a.mentions.others.join(", ")}</p> : null}
          </Part>
          {a.readBy === "google" ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-neutral-500">{GOOGLE_ARTICLE_NOTE}</p>
            </div>
          ) : (
            <>
              <div className="sm:col-span-2">
                <Part title={a.stats.length ? `Stats · ${a.stats.length}${theirOwn ? `, ${theirOwn} from their own data` : ""}` : "Stats"}>
                  {a.stats.length ? (
                    <ul className="space-y-1.5">
                      {a.stats.map((s, i) => (
                        <li key={`${s.figure}-${i}`}>
                          <span className="font-semibold">{s.figure}</span> {s.about}
                          <span className="block text-xs text-neutral-500">
                            &ldquo;{s.quote}&rdquo;{" "}
                            {s.source ? (
                              <>
                                · from <Out href={s.source.url}>{s.source.domain}</Out>
                              </>
                            ) : s.theirOwn ? (
                              "· their own data"
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-neutral-500">No numbers used as evidence.</p>
                  )}
                </Part>
              </div>
              <Part title="Who they cite">
                {a.sources.length ? (
                  <ul className="space-y-0.5">
                    {a.sources.map((s) => (
                      <li key={s.url}>
                        <Out href={s.url}>{s.domain}</Out>
                        {s.anchor ? <span className="text-neutral-500"> · {s.anchor}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-neutral-500">No outside sources.</p>
                )}
              </Part>
              <Part title="What it asks and where it sends readers">
                {a.asks.length || a.pushes.length ? (
                  <ul className="space-y-0.5">
                    {a.asks.map((x) => (
                      <li key={x.url}>
                        <span className="font-medium">{askLabel(x.kind)}</span> <span className="text-neutral-500">({x.placement === "top" ? "at the top" : x.placement === "end" ? "at the end" : "in the text"})</span> ·{" "}
                        <Out href={x.url}>{x.text || pathOf(x.url)}</Out>
                      </li>
                    ))}
                    {a.pushes.map((p) => (
                      <li key={p.url}>
                        <Out href={p.url}>{pathOf(p.url)}</Out>
                        {p.anchor ? <span className="text-neutral-500"> · {p.anchor}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-neutral-500">No asks or links to their own pages.</p>
                )}
              </Part>
            </>
          )}
          <div className="text-xs text-neutral-500 sm:col-span-2">
            <Out href={a.url}>Open the article</Out>
            {a.author ? ` · by ${a.author}` : ""}
            {a.updatedAt && a.updatedAt !== a.publishedAt ? ` · updated ${shortDate(a.updatedAt)}` : ""}
            {a.words ? ` · ${a.words.toLocaleString()} words` : ""}
          </div>
        </div>
      </details>
    </li>
  );
}

export function CompetitorArticles({ articles, totals, subjectNames }: { articles: ArticleView[]; totals: ArticleTotals; subjectNames: Record<string, string> }) {
  const read = articles.filter((a) => a.status === "read");
  const notRead = articles.filter((a) => a.status === "failed" || a.status === "skipped");
  if (!read.length) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        {totals.waiting
          ? `We read their articles a few at a time. ${totals.waiting} ${totals.waiting === 1 ? "is" : "are"} waiting, and the first ones show here within the hour.`
          : "No articles read yet. We read each new post after the weekly check of their news page."}
      </p>
    );
  }
  const list = (rows: Array<{ key: string; count: number }>, word: (k: string) => string = (k) => k) =>
    rows.length ? rows.map((r) => `${word(r.key)} ${r.count}`).join(" · ") : "None yet";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={`${totals.read} read${totals.waiting ? `, ${totals.waiting} waiting` : ""}`}>{list(totals.formats, formatLabel)}</Tile>
        <Tile label="Written for">{totals.roles.length ? totals.roles.map((r) => r.key).join(", ") : "None yet"}</Tile>
        <Tile label="They ask for">{list(totals.asks, askLabel)}</Tile>
        <Tile label="Pages they send readers to most">{totals.pushed.length ? totals.pushed.map((p) => p.key).join(" · ") : "None yet"}</Tile>
      </div>
      <p className="text-xs text-neutral-500">
        {totals.stats.total
          ? `${totals.stats.total} stats across these articles, ${totals.stats.theirOwn} from their own data.`
          : "No stats used as evidence yet."}
        {totals.cited.length ? ` They cite ${totals.cited.map((c) => c.key).join(", ")}.` : " They cite no outside sources."}
      </p>
      {totals.readThroughGoogle ? <Banner tone="info">{GOOGLE_ARTICLE_NOTE}</Banner> : null}
      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {read.map((a) => (
          <Article key={a.id} a={a} subjectNames={subjectNames} />
        ))}
      </ul>
      {notRead.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-500">Not read · {notRead.length}</summary>
          <ul className="mt-2 space-y-1">
            {notRead.map((a) => (
              <li key={a.id}>
                <Out href={a.url}>{a.title || pathOf(a.url)}</Out>
                <span className="text-xs text-neutral-500"> · {a.problem ? ARTICLE_PROBLEM_TEXT[a.problem] : "Not read."}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
