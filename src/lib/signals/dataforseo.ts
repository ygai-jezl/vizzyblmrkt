import type { SerpCite, SerpFindings, SerpNumbers, SerpResult, SignalMarket } from "@/lib/types/brandSignal";
import { marketOf } from "./markets";

/**
 * Google's results for one question, through DataForSEO's SERP API (SIGNALS_DATAFORSEO_ENABLED).
 * The standard method: post a task, collect it a little later (Vizzybl does the same). Plain fetch
 * to a fixed vendor address, with a timeout, as the Mandrill client does.
 *
 * The login (DATAFORSEO_USERNAME, DATAFORSEO_PASSWORD) is read when a call is made and never put
 * in a log line, an error or a record.
 */

const API = "https://api.dataforseo.com";
const POST_PATH = "/v3/serp/google/organic/task_post";
const GET_PATH = "/v3/serp/google/organic/task_get/advanced/";
const TIMEOUT_MS = 20_000;

/** DataForSEO's codes: OK, task created, and "not ready yet" (handed over, in the queue). */
const OK = 20000;
const CREATED = 20100;
const NOT_READY = new Set([40601, 40602]);

/** Results kept: the first page. */
export const TOP = 10;
/**
 * People also ask questions opened, one level (each click shows more questions, at a small extra
 * cost). Two levels drifted far from the question (a lookup about Search Console ended on Gemini
 * the star sign), and the judge (judge.ts) checks what is left.
 */
export const PAA_CLICK_DEPTH = 1;

export type DataForSeoFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DataForSeoDeps {
  fetch?: DataForSeoFetch;
  env?: Record<string, string | undefined>;
}

export type PostResult = { ok: true; taskId: string; cost: number | null } | { ok: false; error: string };
export type GetResult = { ok: true; raw: unknown; cost: number | null } | { ok: false; notReady: true } | { ok: false; notReady?: false; error: string };

/** Whether this copy has a DataForSEO login. */
export function dataForSeoConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.DATAFORSEO_USERNAME?.trim() && env.DATAFORSEO_PASSWORD?.trim());
}

function authHeader(env: Record<string, string | undefined>): string | null {
  const user = env.DATAFORSEO_USERNAME?.trim();
  const pass = env.DATAFORSEO_PASSWORD?.trim();
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

type Envelope = { status_code?: number; cost?: number; tasks?: Array<{ id?: string; status_code?: number; cost?: number; result?: unknown[] | null }> };

async function call(method: "GET" | "POST", path: string, body: unknown, deps: DataForSeoDeps): Promise<{ ok: true; env: Envelope } | { ok: false; error: string }> {
  const auth = authHeader(deps.env ?? process.env);
  if (!auth) return { ok: false, error: "not_configured" };
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Never pass the error on whole: a request error can carry its headers.
    return { ok: false, error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "login_refused" };
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const env = (await res.json().catch(() => null)) as Envelope | null;
  if (!env || typeof env !== "object") return { ok: false, error: "bad_answer" };
  if (env.status_code !== OK) return { ok: false, error: `dataforseo_${env.status_code ?? "unknown"}` };
  return { ok: true, env };
}

const costOf = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** Ask DataForSEO to look a question up. `priority` 2 (faster, costs more) when a person waits. */
export async function postSerpTask(
  query: string,
  market: SignalMarket,
  opts: { tag: string; priority: 1 | 2 },
  deps: DataForSeoDeps = {},
): Promise<PostResult> {
  const m = marketOf(market.country);
  if (!m) return { ok: false, error: "unknown_market" };
  const got = await call(
    "POST",
    POST_PATH,
    [
      {
        keyword: query.trim().slice(0, 700),
        location_code: m.locationCode,
        language_code: market.language,
        device: "desktop",
        depth: TOP,
        people_also_ask_click_depth: PAA_CLICK_DEPTH,
        load_async_ai_overview: true,
        priority: opts.priority,
        tag: opts.tag.slice(0, 255),
      },
    ],
    deps,
  );
  if (!got.ok) return got;
  const task = got.env.tasks?.[0];
  if (!task?.id || (task.status_code !== CREATED && task.status_code !== OK)) return { ok: false, error: `dataforseo_${task?.status_code ?? "no_task"}` };
  return { ok: true, taskId: task.id, cost: costOf(task.cost ?? got.env.cost) };
}

/** Collect a task: its raw result, "not ready yet", or why it failed. */
export async function getSerpTask(taskId: string, deps: DataForSeoDeps = {}): Promise<GetResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(taskId)) return { ok: false, error: "bad_task_id" };
  const got = await call("GET", `${GET_PATH}${taskId}`, undefined, deps);
  if (!got.ok) return got;
  const task = got.env.tasks?.[0];
  if (task?.status_code && NOT_READY.has(task.status_code)) return { ok: false, notReady: true };
  if (task?.status_code !== OK) return { ok: false, error: `dataforseo_${task?.status_code ?? "no_task"}` };
  return { ok: true, raw: task.result?.[0] ?? null, cost: costOf(task.cost) };
}

// ---- Reading the result -------------------------------------------------------------------------

type Item = Record<string, unknown>;
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Item | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : null);

/** A host without "www.", lower case, or "" when the address doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Google's own "/url?q=" links lead somewhere else: keep where they lead. */
export function unwrapGoogleUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url") || url;
  } catch {
    // not an address
  }
  return url;
}

/** Whether a host is the brand's own site or one of its subdomains. */
export function isOwnHost(host: string, own: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return Boolean(h) && own.some((o) => h === o || h.endsWith(`.${o}`));
}

/** Words from a list of strings or of objects with a title (DataForSEO uses both). */
function wordsOf(items: unknown[], max: number): string[] {
  const out: string[] = [];
  for (const it of items) {
    const s = typeof it === "string" ? str(it, 200) : str(obj(it)?.title, 200) || str(obj(it)?.query, 200);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Google's own host (google.com, google.co.uk), which a wrapped result link points at instead of the site. */
const isGoogleHost = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host);

/** The site in a result's breadcrumb ("https://www.reddit.com › r › ChatGPT"), or "". */
function breadcrumbHost(crumb: string): string {
  const first = crumb.split(/\s+›\s+|\s+>\s+/)[0]?.trim() ?? "";
  if (!first) return "";
  return hostOf(/^https?:\/\//.test(first) ? first : `https://${first}`);
}

/**
 * Where a result really leads. Google now wraps result links (google.com/goto?url=...), so the
 * address and domain can name Google itself: then the breadcrumb names the site, and the address
 * is the site's home when the real one can't be read.
 */
function siteOf(it: Item): { domain: string; url: string } | null {
  const url = unwrapGoogleUrl(str(it.url, 2000));
  const host = hostOf(url);
  const named = str(it.domain, 200).toLowerCase().replace(/^www\./, "");
  if (url && host && !isGoogleHost(host)) return { domain: named && !isGoogleHost(named) ? named : host, url };
  const crumb = breadcrumbHost(str(it.breadcrumb, 300));
  const site = [named, crumb].find((h) => h && !isGoogleHost(h));
  if (site) return { domain: site, url: `https://${site}` };
  return null;
}

function citeOf(ref: Item): SerpCite | null {
  const site = siteOf(ref);
  if (!site) return null;
  return { domain: site.domain, url: site.url, title: str(ref.title, 200) || str(ref.source, 200) };
}

/**
 * What we keep of a DataForSEO "advanced" result: the top results, People also ask, also
 * searched, related searches and the AI Overview's cited pages. `ownHosts` are the brand's own
 * site hosts (no "www."), to find where it ranks. Pure; anything missing is just left out.
 */
export function parseSerp(raw: unknown, ownHosts: string[]): { numbers: SerpNumbers; results: SerpFindings } {
  const items = arr(obj(raw)?.items).map(obj).filter((i): i is Item => Boolean(i));
  const top: SerpResult[] = [];
  const paa: SerpFindings["paa"] = [];
  const alsoSearched: string[] = [];
  const related: string[] = [];
  let aiOverview: SerpFindings["aiOverview"] = null;

  for (const it of items) {
    const type = str(it.type, 60);
    if (type === "organic" && top.length < TOP) {
      const site = siteOf(it);
      if (!site) continue;
      const position = typeof it.rank_group === "number" ? it.rank_group : top.length + 1;
      top.push({ position, domain: site.domain, url: site.url, title: str(it.title, 200) });
    } else if (type === "people_also_ask") {
      for (const el of arr(it.items).map(obj)) {
        const question = str(el?.title, 300);
        if (!question || paa.some((p) => p.question.toLowerCase() === question.toLowerCase())) continue;
        const expanded = obj(arr(el?.expanded_element)[0]);
        const ref = obj(arr(expanded?.references)[0]);
        const url = unwrapGoogleUrl(str(expanded?.url, 2000) || str(ref?.url, 2000)) || null;
        const domain = (str(expanded?.domain, 200) || str(ref?.domain, 200) || (url ? hostOf(url) : "")).replace(/^www\./, "") || null;
        paa.push({ question, url: url && /^https?:\/\//.test(url) ? url : null, domain });
        if (paa.length >= 12) break;
      }
    } else if (type === "people_also_search") {
      for (const w of wordsOf(arr(it.items), 12)) if (!alsoSearched.includes(w)) alsoSearched.push(w);
    } else if (type === "related_searches") {
      for (const w of wordsOf(arr(it.items), 12)) if (!related.includes(w)) related.push(w);
    } else if (type === "ai_overview" && !aiOverview) {
      const refs = [...arr(it.references), ...arr(it.items).flatMap((sub) => arr(obj(sub)?.references))];
      const cites: SerpCite[] = [];
      for (const r of refs.map(obj)) {
        const c = r ? citeOf(r) : null;
        if (c && !cites.some((x) => x.url === c.url)) cites.push(c);
        if (cites.length >= 15) break;
      }
      aiOverview = { cites };
    }
  }

  const own = ownHosts.map((h) => h.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const mine = top.find((r) => isOwnHost(r.domain, own) || isOwnHost(hostOf(r.url), own));
  return {
    numbers: {
      googlePosition: mine ? mine.position : null,
      peopleAlsoAsk: paa.length,
      aiOverviewSources: aiOverview?.cites.length ?? 0,
      aiOverviewCitesYou: aiOverview ? aiOverview.cites.some((c) => isOwnHost(c.domain, own) || isOwnHost(hostOf(c.url), own)) : null,
    },
    results: { top, paa, alsoSearched, related, aiOverview },
  };
}
