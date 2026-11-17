"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/components/admin/connect/api";
import { Badge, Banner, Button, Field, Section, Tabs, inputClass } from "@/components/admin/connect/ui";
import { BRAND_KIT_COMPETITORS_ROUTE } from "@/lib/content/brandKit";
import { COMPETITOR_LIMITS, type ChangedSection, type CompetitorChange } from "@/lib/types/competitor";
import { GOOGLE_NOTE, PROBLEM_TEXT, STATUS_LABEL, formatLabel, type CompetitorDetail as Detail } from "@/lib/competitors/view";
import { BRAND_MAP_NOTE, shortDate, statsLine } from "./CompetitorsPage";
import { CompetitorArticles } from "./CompetitorArticles";

/**
 * Brand › Competitors › one competitor: what changed (newest first), how their site is built,
 * their news page, and its settings. Members read; admins change, check and stop watching.
 */

type Tab = "changes" | "site" | "articles" | "news" | "settings";

const SETTING_UP = new Set(["finding", "reading", "analysing"]);

/** A page on their site (every path we show is one we read from it). */
function pageUrl(path: string, website: string): string {
  return path.startsWith("//") ? `https:${path}` : `${website}${path}`;
}

function TheirLink({ path, website, children }: { path: string; website: string; children?: ReactNode }) {
  return (
    <a href={pageUrl(path, website)} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline decoration-neutral-300 hover:decoration-neutral-600">
      {children ?? path}
    </a>
  );
}

function Sections({ title, side, website }: { title: string; side: { count: number; sections: ChangedSection[] }; website: string }) {
  if (!side.count) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {title}: {side.count.toLocaleString()}
      </p>
      <ul className="space-y-1">
        {side.sections.map((s) => (
          <li key={s.section}>
            <details>
              <summary className="cursor-pointer text-sm">
                {s.section} <span className="text-neutral-500">· {s.count.toLocaleString()}</span>
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4 text-xs text-neutral-600 dark:text-neutral-400">
                {s.sample.slice(0, 20).map((p) => (
                  <li key={p}>
                    <TheirLink path={p} website={website} />
                  </li>
                ))}
                {s.count > 20 ? <li>and {(s.count - 20).toLocaleString()} more</li> : null}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Change({ change, website, formats }: { change: CompetitorChange; website: string; formats: Map<string, string> }) {
  return (
    <li className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {change.seenAt === null ? <span className="mr-1.5 inline-block size-2 rounded-full bg-blue-500" aria-label="New" /> : null}
          {change.headline}
        </p>
        <span className="text-xs text-neutral-500">
          {change.kind === "posts" ? "News page" : "Their site"} · {shortDate(change.at)}
        </span>
      </div>
      {change.summary ? <p className="text-sm text-neutral-700 dark:text-neutral-300">{change.summary}</p> : null}
      {change.topics.length ? (
        <div className="flex flex-wrap gap-1">
          {change.topics.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      ) : null}
      {change.posts.length ? (
        <ul className="space-y-1 text-sm">
          {change.posts.map((p) => (
            <li key={p.url}>
              <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-neutral-300 hover:decoration-neutral-600">
                {p.title || p.url}
              </a>
              {p.publishedAt ? <span className="text-xs text-neutral-500"> · {shortDate(p.publishedAt)}</span> : null}
              {formats.get(p.url) ? <span className="text-xs text-neutral-500"> · {formats.get(p.url)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {change.kind === "site" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Sections title="Pages added" side={change.added} website={website} />
          <Sections title="Pages removed" side={change.removed} website={website} />
        </div>
      ) : null}
    </li>
  );
}

function Months({ months }: { months: Array<{ month: string; pages: number }> }) {
  const max = Math.max(1, ...months.map((m) => m.pages));
  if (!months.some((m) => m.pages)) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Pages dated each month (from their sitemap)</p>
      <div className="flex h-16 items-end gap-1" role="img" aria-label={months.map((m) => `${m.month}: ${m.pages}`).join(", ")}>
        {months.map((m) => (
          <div key={m.month} className="flex-1 rounded-t bg-blue-500/70" style={{ height: `${Math.max(2, (m.pages / max) * 100)}%` }} title={`${m.month}: ${m.pages}`} />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span>{months[0]?.month}</span>
        <span>{months.at(-1)?.month}</span>
      </div>
    </div>
  );
}

export function CompetitorDetail({ initial, canEdit }: { initial: Detail; canEdit: boolean }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [tab, setTab] = useState<Tab>(initial.changes.length ? "changes" : "site");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState(initial.name);
  const [newsUrl, setNewsUrl] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);

  const base = `/api/admin/brand-kit/competitors/${c.id}`;
  // A post read in full shows its format beside it in What changed.
  const formats = new Map((c.articles ?? []).flatMap((x) => (x.status === "read" && x.format ? [[x.url, formatLabel(x.format)] as const] : [])));

  async function run(label: string, path: string, init: RequestInit, after?: (data: Record<string, unknown>) => void) {
    setBusy(label);
    setError(null);
    setNote(null);
    const r = await api<{ competitor?: Detail }>(path, init);
    setBusy(null);
    if (!r.ok) return setError(errorText(r.data));
    if (r.data.competitor) setC(r.data.competitor);
    after?.(r.data as Record<string, unknown>);
  }

  const action = (label: string, a: "advance" | "check" | "retry" | "brand_map") => run(label, base, { method: "POST", body: JSON.stringify({ action: a }) });
  const patch = (label: string, body: Record<string, unknown>, after?: () => void) => run(label, base, { method: "PATCH", body: JSON.stringify(body) }, after);

  // Carry setup on while it runs (admins), the way the list does. An error stops it until the person acts.
  useEffect(() => {
    if (!canEdit || !SETTING_UP.has(c.status) || busy || error) return;
    const timer = setTimeout(() => void action("advance", "advance"), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, canEdit, busy, error]);

  const a = c.analysis;
  const unseen = c.changes.filter((ch) => ch.seenAt === null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{c.name}</h1>
          <p className="text-sm text-neutral-500">
            <a href={c.website} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-neutral-300 hover:decoration-neutral-600">
              {c.site}
            </a>
            {statsLine(c) ? ` · ${statsLine(c)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={c.status === "watching" ? "green" : c.status === "needs_you" ? "red" : c.status === "paused" ? "neutral" : "amber"}>
            {c.status === "reading" && c.progress?.total ? `Reading their site, ${c.progress.done} of ${c.progress.total}` : STATUS_LABEL[c.status]}
          </Badge>
          {c.onBrandMap ? (
            <Badge>On your brand map</Badge>
          ) : canEdit ? (
            <Button
              disabled={busy !== null}
              onClick={() =>
                void run("map", base, { method: "POST", body: JSON.stringify({ action: "brand_map" }) }, (d) => {
                  const how = d.brandMap as keyof typeof BRAND_MAP_NOTE | undefined;
                  if (how && BRAND_MAP_NOTE[how]) setNote(BRAND_MAP_NOTE[how](c.name));
                })
              }
            >
              Not on your brand map · Add it
            </Button>
          ) : (
            <Badge tone="amber">Not on your brand map</Badge>
          )}
        </div>
      </div>

      {c.problem ? <Banner tone={c.status === "needs_you" ? "err" : "info"}>{PROBLEM_TEXT[c.problem]}</Banner> : null}
      {c.readThroughGoogle && !c.problem && c.status === "watching" ? <Banner tone="info">{GOOGLE_NOTE}</Banner> : null}
      {c.status === "needs_you" && canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy !== null} onClick={() => void action("retry", "retry")}>
            {busy === "retry" ? "Trying…" : "Try again"}
          </Button>
          <Button onClick={() => setTab("settings")}>Paste their sitemap or news page</Button>
        </div>
      ) : null}
      {error ? <Banner tone="err">{error}</Banner> : null}
      {note ? <Banner tone="ok">{note}</Banner> : null}

      <Tabs<Tab>
        tabs={[
          { id: "changes", label: unseen ? `What changed · ${unseen}` : "What changed" },
          { id: "site", label: "How their site is built" },
          ...(c.articles ? [{ id: "articles" as const, label: "What they write" }] : []),
          { id: "news", label: "News page" },
          ...(canEdit ? [{ id: "settings" as const, label: "Settings" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "changes" ? (
        <div className="space-y-3">
          {unseen && canEdit ? (
            <div className="flex justify-end">
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void run("seen", "/api/admin/brand-kit/competitors/seen", { method: "POST", body: JSON.stringify({ competitorId: c.id }) }, () => {
                    const at = new Date().toISOString();
                    setC((cur) => ({ ...cur, unseen: 0, latest: null, changes: cur.changes.map((ch) => (ch.seenAt === null ? { ...ch, seenAt: at } : ch)) }));
                    router.refresh();
                  })
                }
              >
                Mark all seen
              </Button>
            </div>
          ) : null}
          {c.changes.length ? (
            <ul className="space-y-3">
              {c.changes.map((ch) => (
                <Change key={ch.id} change={ch} website={c.website} formats={formats} />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Nothing has changed since we first read their site.
              {c.nextCheckAt ? ` Next check ${shortDate(c.nextCheckAt)}.` : ""}
            </p>
          )}
        </div>
      ) : null}

      {tab === "articles" && c.articles && c.articleTotals ? (
        <CompetitorArticles articles={c.articles} totals={c.articleTotals} subjectNames={c.subjectNames} />
      ) : null}

      {tab === "site" ? (
        a ? (
          <div className="space-y-4">
            {!a.ai ? (
              <Banner tone="info">These are the numbers from their sitemap. Words for them need the AI model, which isn&rsquo;t set up here.</Banner>
            ) : null}
            {a.summary ? <p className="text-sm">{a.summary}</p> : null}
            {a.worthKnowing.length ? (
              <Section title="Worth knowing">
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {a.worthKnowing.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <Section
              title="Sections"
              description={`${c.truncated ? "From the first " : "From "}${(a.stats.pages ?? 0).toLocaleString()} pages in their sitemap${a.stats.languages.length ? `, in ${a.stats.languages.join(", ")}` : ""}.`}
            >
              <table className="w-full text-sm">
                <tbody>
                  {a.sections.map((s) => (
                    <tr key={s.path} className="border-t border-neutral-100 align-top dark:border-neutral-900">
                      <td className="py-1.5 pr-3">
                        <TheirLink path={s.path === "/" ? "/" : s.path} website={c.website}>
                          {s.label || s.path}
                        </TheirLink>
                        {s.label ? <span className="block text-xs text-neutral-500">{s.path === "/" ? "Pages at the top of the site" : s.path}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 text-neutral-600 dark:text-neutral-300">{s.purpose}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.pages.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Months months={a.stats.datedByMonth} />
            </Section>
            {a.themes.length ? (
              <Section title="What their pages are about">
                <ul className="space-y-2 text-sm">
                  {a.themes.map((t) => (
                    <li key={t.name}>
                      <span className="font-medium">{t.name}</span>
                      <span className="block text-xs text-neutral-500">
                        {t.paths.map((p, i) => (
                          <span key={p}>
                            {i ? ", " : ""}
                            <TheirLink path={p} website={c.website} />
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {a.notable.length ? (
              <Section title="Pages to know about">
                <ul className="space-y-2 text-sm">
                  {a.notable.map((n) => (
                    <li key={n.path}>
                      <TheirLink path={n.path} website={c.website}>
                        {n.label}
                      </TheirLink>
                      {n.why ? <span className="block text-xs text-neutral-500">{n.why}</span> : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {SETTING_UP.has(c.status)
              ? "We're still reading their site. This fills in when we're done."
              : c.readThroughGoogle
                ? "We can't see their whole site, because it turns away automated readers like ours. We watch their news through Google instead."
                : "We haven't read a sitemap for this site."}
          </p>
        )
      ) : null}

      {tab === "news" ? (
        <div className="space-y-4">
          <Section
            title="Their news page"
            description={c.newsUrl ? "We check it every week for new posts." : "We haven't found a news or blog page on their site."}
          >
            {c.newsUrl ? (
              <p className="text-sm">
                <a href={c.newsUrl} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline decoration-neutral-300 hover:decoration-neutral-600">
                  {c.newsUrl}
                </a>
                <span className="block text-xs text-neutral-500">
                  {c.readThroughGoogle ? "Read through Google, from the sitemap file that lists their posts." : c.feed ? "Read from its feed." : "Read from the page itself."}
                  {c.nextPostsCheckAt ? ` Next check ${shortDate(c.nextPostsCheckAt)}.` : ""}
                </span>
              </p>
            ) : null}
            {canEdit ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void patch("news", { newsUrl }, () => setNewsUrl(""));
                }}
              >
                <div className="min-w-0 flex-1">
                  <Field label={c.newsUrl ? "A different news page" : "Their news page"}>
                    <input className={inputClass} value={newsUrl} placeholder={`${c.website}/news`} onChange={(e) => setNewsUrl(e.target.value)} />
                  </Field>
                </div>
                <Button type="submit" disabled={busy !== null || !newsUrl.trim()}>
                  Use this page
                </Button>
              </form>
            ) : null}
          </Section>
          {c.posts.length ? (
            <Section title="New posts we've seen">
              <ul className="space-y-1 text-sm">
                {c.posts.map((p) => (
                  <li key={p.url}>
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-neutral-300 hover:decoration-neutral-600">
                      {p.title || p.url}
                    </a>
                    <span className="text-xs text-neutral-500"> · seen {shortDate(p.firstSeenAt)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      ) : null}

      {tab === "settings" && canEdit ? (
        <div className="space-y-4">
          <Section title="Name" description="How it's called here. Changing it doesn't change your brand map.">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void patch("name", { name });
              }}
            >
              <input className={`${inputClass} max-w-sm`} value={name} maxLength={COMPETITOR_LIMITS.MAX_NAME} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" disabled={busy !== null || !name.trim() || name.trim() === c.name}>
                Save
              </Button>
            </form>
          </Section>
          <Section
            title="Their sitemap"
            description={
              c.sitemapFiles.length
                ? `We read ${c.sitemapFiles.length} sitemap file${c.sitemapFiles.length === 1 ? "" : "s"}. We read them again every month.${c.nextSiteCheckAt ? ` Next ${shortDate(c.nextSiteCheckAt)}.` : ""}`
                : "We haven't read a sitemap for this site."
            }
          >
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void patch("sitemap", { sitemapUrl }, () => setSitemapUrl(""));
              }}
            >
              <div className="min-w-0 flex-1">
                <Field label="Use a different sitemap" hint="Its address on their site, often ending in sitemap.xml.">
                  <input className={inputClass} value={sitemapUrl} placeholder={`${c.website}/sitemap.xml`} onChange={(e) => setSitemapUrl(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" disabled={busy !== null || !sitemapUrl.trim()}>
                Read this sitemap
              </Button>
            </form>
          </Section>
          <Section title="Checks">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy !== null || c.status !== "watching"} onClick={() => void action("check", "check")}>
                {busy === "check" ? "Checking…" : "Check now"}
              </Button>
              {c.status === "paused" ? (
                <Button disabled={busy !== null} onClick={() => void patch("pause", { paused: false })}>
                  Resume
                </Button>
              ) : (
                <Button disabled={busy !== null || c.status === "needs_you"} onClick={() => void patch("pause", { paused: true })}>
                  Pause
                </Button>
              )}
            </div>
            <p className="text-xs text-neutral-500">Check now reads their news page and sitemap again straight away. You can do it three times an hour.</p>
          </Section>
          <Section title="Stop watching" description="Everything we read about this site goes. Its name stays on your brand map.">
            {confirmStop ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("stop", base, { method: "DELETE" }, () => {
                      router.push(BRAND_KIT_COMPETITORS_ROUTE);
                      router.refresh();
                    })
                  }
                >
                  Yes, stop watching {c.name}
                </Button>
                <Button onClick={() => setConfirmStop(false)}>Keep watching</Button>
              </div>
            ) : (
              <Button tone="danger" onClick={() => setConfirmStop(true)}>
                Stop watching
              </Button>
            )}
          </Section>
        </div>
      ) : null}
    </div>
  );
}
