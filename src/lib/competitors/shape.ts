import type { CompetitorStats, SectionCount } from "@/lib/types/competitor";
import type { BaselinePage } from "./sitemap";

/**
 * How a competitor's site is built, worked out by code from its baseline: sections and their page
 * counts, languages, pages dated per month, and the sections that look like a news page. Every
 * number on the page comes from here; the model only puts words to it. Pure.
 */

/** Top-level sections listed at most. */
const MAX_SECTIONS = 25;
/** A section this big (and this share of the site) is split one level further. */
const SPLIT_PAGES = 200;
const SPLIT_SHARE = 0.25;
const MAX_CHILDREN = 10;

/** The first segment of a key: "/news/" for "/news/some-post" (and for "/news" itself), "//blog.acme.example/" for a subdomain, "/" for the top. */
export function sectionOf(key: string): string {
  if (key.startsWith("//")) {
    const host = key.slice(2).split("/")[0] ?? "";
    return `//${host}/`;
  }
  const first = (key.split("?")[0] ?? "").split("/").filter(Boolean)[0];
  return first ? `/${first}/` : "/";
}

/**
 * Each page's section for this site: like sectionOf, except a page that is alone in its section
 * ("/about", "/contact") counts as a top-level page ("/"), so a site isn't read as fifty
 * one-page sections.
 */
export function sectionResolver(pages: BaselinePage[]): (key: string) => string {
  const counts = new Map<string, number>();
  for (const p of pages) counts.set(sectionOf(p.key), (counts.get(sectionOf(p.key)) ?? 0) + 1);
  return (key: string) => {
    const s = sectionOf(key);
    return s !== "/" && !s.startsWith("//") && (counts.get(s) ?? 0) <= 1 ? "/" : s;
  };
}

/** The first two segments, for splitting a big section: "/en/news/". */
function subsectionOf(key: string): string | null {
  if (key.startsWith("//")) {
    const [host, first] = key.slice(2).split("/");
    return first ? `//${host}/${first}/` : null;
  }
  const parts = (key.split("?")[0] ?? "").split("/").filter(Boolean);
  return parts.length >= 3 ? `/${parts[0]}/${parts[1]}/` : null;
}

/** Sections with their page counts, biggest first; a big one is followed by its own biggest parts. */
export function sectionTree(pages: BaselinePage[]): SectionCount[] {
  const sectionFor = sectionResolver(pages);
  const top = new Map<string, number>();
  for (const p of pages) top.set(sectionFor(p.key), (top.get(sectionFor(p.key)) ?? 0) + 1);
  const ordered = [...top].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SECTIONS);
  const out: SectionCount[] = [];
  for (const [path, count] of ordered) {
    out.push({ path, pages: count });
    if (path === "/" || count < SPLIT_PAGES || count / Math.max(1, pages.length) < SPLIT_SHARE) continue;
    const parts = new Map<string, number>();
    for (const p of pages) {
      if (sectionFor(p.key) !== path) continue;
      const sub = subsectionOf(p.key);
      if (sub) parts.set(sub, (parts.get(sub) ?? 0) + 1);
    }
    const kids = [...parts].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_CHILDREN);
    // Split only when the parts tell more than the whole: at least two of them.
    if (kids.length >= 2) for (const [p, n] of kids) out.push({ path: p, pages: n });
  }
  return out;
}

const LANGUAGES = new Set([
  "en", "fr", "de", "es", "it", "pt", "nl", "sv", "da", "no", "nb", "fi", "pl", "cs", "sk", "ja", "zh", "ko", "ru", "tr",
  "ar", "he", "el", "hu", "ro", "uk", "id", "th", "vi", "hi", "ms", "bg", "hr", "sl", "et", "lv", "lt", "ca",
]);

/** Language prefixes ("fr", "de-at"), when the site has at least two with a few pages each. */
export function languagesOf(pages: BaselinePage[]): string[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    if (p.key.startsWith("//")) continue;
    const first = (p.key.split("/").filter(Boolean)[0] ?? "").toLowerCase();
    const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/.exec(first);
    if (!m || !LANGUAGES.has(m[1]!)) continue;
    counts.set(first.replace("_", "-"), (counts.get(first.replace("_", "-")) ?? 0) + 1);
  }
  const langs = [...counts].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return langs.length >= 2 ? langs.slice(0, 20) : [];
}

/** "2026-11" for a date. */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** The last `months` calendar months, oldest first, ending with this one. */
function lastMonths(now: Date, months: number): string[] {
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** Pages with a lastmod in each of the last 12 months. */
export function datedByMonth(pages: BaselinePage[], now: Date): Array<{ month: string; pages: number }> {
  const months = lastMonths(now, 12);
  const counts = new Map(months.map((m) => [m, 0]));
  for (const p of pages) {
    if (!p.lastmod) continue;
    const m = monthOf(p.lastmod);
    if (counts.has(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return months.map((month) => ({ month, pages: counts.get(month) ?? 0 }));
}

/** Words a news, blog or updates section goes by, in the languages sites are written in most. */
const NEWS_WORDS = [
  "blog", "news", "newsroom", "insights", "articles", "article", "posts", "journal", "stories", "press", "updates",
  "changelog", "resources", "magazine", "media", "learn", "guides", "actualites", "actualite", "actus", "noticias",
  "novedades", "nieuws", "aktuelles", "neuigkeiten", "notizie", "novidades", "blogg", "nyheter", "uutiset", "aktualnosci",
];

export interface NewsCandidate {
  /** A section key ("/blog/" or "//blog.acme.example/"). */
  path: string;
  pages: number;
}

/** Sections whose name says news, biggest first (a subdomain such as blog.… counts too). */
export function newsCandidates(sections: SectionCount[]): NewsCandidate[] {
  const scored = sections
    .map((s) => {
      const name = s.path.startsWith("//")
        ? (s.path.slice(2).split(/[./]/)[0] ?? "")
        : (s.path.split("/").filter(Boolean).at(-1) ?? "");
      const rank = NEWS_WORDS.indexOf(name.toLowerCase());
      return { s, rank };
    })
    .filter((x) => x.rank !== -1 && x.s.pages >= 3);
  return scored
    .sort((a, b) => b.s.pages - a.s.pages || a.rank - b.rank)
    .slice(0, 5)
    .map((x) => ({ path: x.s.path, pages: x.s.pages }));
}

/** Pages under a section key. */
export function inSection(key: string, section: string): boolean {
  if (section === "/") return true;
  if (section.startsWith("//")) return key === section.slice(0, -1) || key.startsWith(section);
  return key.startsWith(section) || `${key}/` === section;
}

/** Posts a month under the news section, from the sitemap's dates over the last 6 months (null: too few dates). */
export function newsPerMonth(pages: BaselinePage[], section: string | null, now: Date): number | null {
  if (!section) return null;
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate())).toISOString().slice(0, 10);
  const dated = pages.filter((p) => inSection(p.key, section) && p.key !== section.replace(/\/$/, "") && p.lastmod);
  if (dated.length < 3) return null;
  const recent = dated.filter((p) => (p.lastmod ?? "") >= since).length;
  return Math.round((recent / 6) * 10) / 10;
}

/** The numbers for a baseline. */
export function statsOf(pages: BaselinePage[], now: Date, newsSection: string | null = null): CompetitorStats {
  const sections = sectionTree(pages);
  return {
    pages: pages.length,
    sections,
    languages: languagesOf(pages),
    datedByMonth: datedByMonth(pages, now),
    newsPerMonth: newsPerMonth(pages, newsSection, now),
  };
}

/** Up to `max` sample paths, spread across sections (each gets a few, big ones more). */
export function samplePaths(pages: BaselinePage[], sections: SectionCount[], max = 400): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sectionFor = sectionResolver(pages);
  const tops = sections.filter((s) => !sections.some((o) => o !== s && s.path.startsWith(o.path) && o.path !== "/"));
  const total = Math.max(1, tops.reduce((n, s) => n + s.pages, 0));
  for (const s of tops) {
    const share = Math.max(3, Math.min(40, Math.round((s.pages / total) * max)));
    const keys = pages.filter((p) => sectionFor(p.key) === s.path).map((p) => p.key);
    // Spread across the section rather than its first few (often the oldest).
    const step = Math.max(1, Math.floor(keys.length / share));
    const picked: string[] = [];
    for (let i = 0; i < keys.length && picked.length < share; i += step) picked.push(keys[i]!);
    out.set(s.path, picked);
  }
  return out;
}
