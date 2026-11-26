import { forTenant } from "@/lib/tenant";
import { brandMapRecords, type BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import { readKnowledgeChunkTexts } from "@/lib/tenant/knowledge";
import { getTenantById } from "@/lib/tenant/registry";
import { listContentPlans, listIdeaItems, listTemplates } from "@/lib/tenant/workspaceContent";
import type { TenantContext } from "@/lib/tenant/types";
import { listNotes } from "@/lib/brandNotes/store";
import { listImports } from "@/lib/brandMap/imports";
import { listCompetitors } from "@/lib/competitors/store";
import { listReadArticles } from "@/lib/competitors/articles";
import { isBrandSignalsEnabled } from "@/lib/signals/flags";
import { marketLabel } from "@/lib/signals/markets";
import { readySignals } from "@/lib/signals/store";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { LearnedEntry } from "@/lib/types/autopilot";
import { isAutopilotLearningEnabled } from "@/lib/autopilot/flags";
import { learnedLine, listLearned } from "@/lib/autopilot/learned";
import { listLifecycleJourneys } from "@/lib/lifecycle/service";
import { listRepoAnalyses } from "@/lib/connect/repoAnalysis";
import { isConnectorsSearchTextEnabled } from "@/lib/connectors/flags";
import { rolledId, searchTextRef, siteName } from "@/lib/connectors/keys";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { daysIn, dayWords, isoWeekOf } from "@/lib/connectors/period";
import { compareRows, readSnapshot } from "@/lib/connectors/snapshots";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { MetricSnapshot, SnapshotRow } from "@/lib/types/metricSnapshot";
import type { Broadcast } from "@/lib/types/broadcast";
import type { BrandAuthor } from "@/lib/types/brandAuthor";
import type { BrandMapImport, BrandMapStoredRecord } from "@/lib/types/brandMapRecords";
import type { BrandNote } from "@/lib/types/brandNote";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { IdeaItem } from "@/lib/types/ideaItem";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import type { Template } from "@/lib/types/template";
import type { Tenant } from "@/lib/types/tenant";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { readBrandPointers } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import { IMAGE_STYLE_SCOPES } from "@/lib/loops/registry";
import { BRAND_LOOK_SCOPE, lookName } from "@/lib/loops/learnedWords";
import { contentHash } from "./text";
import type { SearchKind, SearchSource, SearchStub } from "./types";

/**
 * What a brand wrote, read through the tenant layer, as search sources. Each kind has a pure
 * mapper (tested without a database) and is read by readBrandStubs. People's words (sign-up
 * answers, AI conversations, social comments, person plans) are not read: they wait for the data
 * processing agreement. Notes that may name a real customer (canName) are left out for the same
 * reason, and so are competitor quotes and authors. Search Console's searches are Google's counts
 * over everyone who searched, not one person's words (decision 37, ADR-0013), so they are read.
 */

const SOCIAL_CHANNELS = new Set(["linkedin", "x", "instagram", "threads", "facebook", "bluesky"]);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const lines = (...parts: Array<string | null | undefined | false>) => parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");
const list = (label: string, items: unknown) =>
  Array.isArray(items) && items.length ? `${label}\n${items.map((i) => `- ${s(i)}`).filter((i) => i.length > 2).join("\n")}` : "";

/** A stub whose record is already in memory: its version is the hash of the source itself. */
export function stubOf(source: SearchSource): SearchStub {
  return {
    kind: source.kind,
    ref: source.ref,
    version: contentHash(source.kind, source.ref, source.title, source.body, source.format, source.url, source.lang),
    load: async () => source,
  };
}

// ── Mappers (pure) ──────────────────────────────────────────────────────────────────────────

const HUB_KIND: Record<string, SearchKind> = { blog: "article", newsletter: "newsletter", ebook: "ebook" };

/** A content plan's hub (article, newsletter or ebook), its social posts and its email steps. */
export function contentPlanSources(plan: ContentPlan): SearchSource[] {
  const base = `/admin/workspace/${plan.workspaceId}/create/${plan.id}`;
  const out: SearchSource[] = [];
  const nodes = plan.graph?.nodes ?? [];
  const hubKind = HUB_KIND[plan.topology?.hubChannel ?? ""] ?? "newsletter";
  const hub = nodes.find((n) => n.type === "hub");
  if (hubKind === "ebook") {
    const draft = plan.ebookDraft;
    const chapters = (draft?.chapters ?? []).map((c) => `<h2>${c.title}</h2>${c.bodyHtml ?? ""}`).join("\n");
    const body = chapters || hub?.body || "";
    if (body.trim() || draft?.title) out.push({ kind: "ebook", ref: plan.id, title: draft?.title || plan.name, body, format: chapters ? "html" : "markdown", url: `${base}/ebook` });
  } else if (hub?.body?.trim()) {
    const meta = (hub as { meta?: { metaTitle?: string } }).meta;
    out.push({ kind: hubKind, ref: plan.id, title: meta?.metaTitle || plan.name, body: hub.body, format: "markdown", url: base });
  }
  for (const n of nodes) {
    if (!n.body?.trim()) continue;
    if (n.type === "email") {
      out.push({ kind: "journey_email", ref: `${plan.id}/${n.id}`, title: n.subject || `${plan.name}: ${n.role}`, body: lines(n.previewText, n.body), format: "plain", url: base });
    } else if ((n.type === "spoke" || n.type === "promo_pre" || n.type === "promo_post") && SOCIAL_CHANNELS.has(n.channel)) {
      out.push({ kind: "post", ref: `${plan.id}/${n.id}`, title: `${plan.name}: ${n.role}`, body: n.body, format: "plain", url: base });
    }
  }
  return out;
}

/** An Idea Board item (a clipping). Written to the index as `idea` until SEARCH_KIND_IDEA_BOARD_ENABLED (storedKindOf). */
export function ideaSource(idea: IdeaItem): SearchSource {
  return {
    kind: "idea_board",
    ref: idea.id,
    title: idea.title,
    body: lines(idea.note, idea.text, idea.url ? `Link: ${idea.url}` : ""),
    url: `/admin/workspace/${idea.workspaceId}/curate/idea-board`,
  };
}

export function templateSource(t: Template): SearchSource {
  return { kind: "template", ref: t.id, title: t.title, body: t.body, format: "markdown", url: `/admin/workspace/${t.workspaceId}/templatize` };
}

export function broadcastSource(b: Broadcast): SearchSource {
  const html = /<[a-z][\s\S]*>/i.test(b.body);
  return { kind: "broadcast", ref: b.id, title: b.subject || b.name, body: lines(b.name !== b.subject ? b.name : "", b.body), format: html ? "html" : "plain", url: `/admin/launches/${b.campaignId}/broadcasts` };
}

/** Each email in a lifecycle journey's draft. */
export function lifecycleSources(j: LifecycleJourney): SearchSource[] {
  const out: SearchSource[] = [];
  for (const pool of j.draft?.pools ?? []) {
    for (const item of pool.items ?? []) {
      if (!item.body?.trim() && !item.subject?.trim()) continue;
      const html = /<[a-z][\s\S]*>/i.test(item.body ?? "");
      out.push({
        kind: "journey_email",
        ref: `${j.id}/${pool.id}/${item.id}`,
        title: item.subject || `${j.name}: ${item.label}`,
        body: lines(item.previewText, item.body),
        format: html ? "html" : "plain",
        url: `/admin/lifecycle/${j.id}`,
      });
    }
  }
  return out;
}

/** The brand's voice, its brand kit and its authors' bios, as one record. */
export function brandKitSource(tenant: Pick<Tenant, "brandVoice" | "brandKit">, authors: BrandAuthor[]): SearchSource | null {
  const v = tenant.brandVoice;
  const k = tenant.brandKit;
  const body = lines(
    v?.summary && `Voice: ${v.summary}`,
    v?.guidelines,
    list("Do", v?.dos),
    list("Don't", v?.donts),
    k?.summary,
    k?.voice && `Voice: ${k.voice}`,
    k?.tone && `Tone: ${k.tone}`,
    k?.imageryStyle && `Imagery: ${k.imageryStyle}`,
    k?.logoUsage && `Logo: ${k.logoUsage}`,
    list("Do", k?.dos),
    list("Don't", k?.donts),
    ...authors.map((a) => lines(`${a.name}${a.role ? `, ${a.role}` : ""}`, a.bio)),
  );
  return body ? { kind: "brand_kit", ref: "brand", title: "Brand voice and kit", body, url: "/admin/brand-kit/voice" } : null;
}

/** A brand map record that is on the map (decided). */
export function brandMapSource(kind: "subject" | "question" | "situation", r: BrandMapStoredRecord): SearchSource | null {
  if (r.status !== "decided") return null;
  if (kind === "subject") {
    const name = s(r.name);
    return name ? { kind, ref: r.ref, title: name, body: lines(name, s(r.description)), url: "/admin/brand-kit/map" } : null;
  }
  if (kind === "question") {
    const text = s(r.text);
    return text ? { kind, ref: r.ref, title: text, body: text, url: "/admin/brand-kit/map" } : null;
  }
  const text = s(r.text);
  return text
    ? { kind, ref: r.ref, title: text, body: lines(text, s(r.who) && `Who: ${s(r.who)}`, s(r.want) && `Wants: ${s(r.want)}`, s(r.feel) && `Feels: ${s(r.feel)}`, s(r.wText)), url: "/admin/brand-kit/map" }
    : null;
}

/** A What we've seen note, or an open question asked of the team. Never one that may name a customer. */
export function noteSource(n: BrandNote): SearchSource | null {
  if (n.canName) return null;
  if (n.status === "asked") return { kind: "question", ref: `note_${n.id}`, title: n.question || n.text, body: lines(n.question, n.text), url: "/admin/brand-kit/notes" };
  if (n.status !== "kept") return null;
  return { kind: "note", ref: n.id, title: n.text.slice(0, 120), body: lines(n.question && `Asked: ${n.question}`, n.text), url: "/admin/brand-kit/notes" };
}

export function importSource(imp: BrandMapImport): SearchSource | null {
  const items = (imp.items ?? []).map((i) => s((i as { text?: unknown }).text)).filter(Boolean);
  return items.length ? { kind: "research", ref: imp.id, title: imp.fileName, body: items.join("\n\n"), url: "/admin/brand-kit/map" } : null;
}

/**
 * What Google showed for one of the brand's questions (BRAND_SIGNALS_ENABLED), as the brand's
 * research, like a PDF import: only what the judge (src/lib/signals/judge.ts) found on the brand's
 * topics, this article's or another's, never what it dropped as off topic. Before it is judged,
 * only the question, its market and the pages Google's AI Overview cited.
 */
export function signalSource(sig: BrandSignal): SearchSource | null {
  if (sig.status !== "ready" || !sig.results) return null;
  const r = sig.results;
  const kept = (sig.judged?.items ?? []).filter((i) => i.verdict !== "drop");
  const asks = kept.filter((i) => i.kind === "paa").map((i) => i.text);
  const also = kept.filter((i) => i.kind === "also").map((i) => i.text);
  const body = lines(
    `${marketLabel(sig.market)}, ${(sig.readyAt ?? "").slice(0, 10)}`,
    asks.length ? `People also ask:\n${asks.map((q) => `- ${q}`).join("\n")}` : "",
    also.length ? `Also searched: ${also.join("; ")}` : "",
    r.aiOverview?.cites.length ? `Google's AI Overview cites: ${r.aiOverview.cites.map((c) => c.title || c.domain).join("; ")}` : "",
  );
  return { kind: "research", ref: `serp:${sig.id}`, title: `Google: ${sig.about.query}`, body, url: "/admin/brand-kit/map" };
}

/** Searches a Search Console connection puts in brand search: the top ones of the 28 days. */
export const SEARCH_TEXT_TOP = 200;
/** The days they cover, to the last collected day: the rolled 28 day doc. */
export const SEARCH_TEXT_DAYS = 28;
const SEARCH_CONSOLE = searchConsoleManifest.id;
const SEARCH_CONSOLE_STREAM = searchConsoleManifest.produces[0]!.stream;

/** A Search Console site as people read it (src/lib/connectors/keys.ts). */
export { siteName } from "@/lib/connectors/keys";

const counted = (n: number, one: string, many: string) => `${Math.round(n).toLocaleString("en-US")} ${Math.round(n) === 1 ? one : many}`;

/** One search with its numbers: "repot a fig: 120 impressions, 4 clicks, position 8.2 in the 28 days to 20 Nov". */
export function searchLine(row: Pick<SnapshotRow, "key" | "m" | "cutDays">, window: { from: string; to: string }): string | null {
  const words = row.key.replace(/\s+/g, " ").trim();
  if (!words) return null;
  const m = row.m;
  // A search under a day's top 500 on some days counts only its kept days: at least these, and no
  // position, which would come from its best days alone.
  const cut = (row.cutDays ?? 0) > 0;
  const numbers = [
    typeof m.searchImpressions === "number" ? `${cut ? "at least " : ""}${counted(m.searchImpressions, "impression", "impressions")}` : "",
    typeof m.searchClicks === "number" ? `${cut ? "at least " : ""}${counted(m.searchClicks, "click", "clicks")}` : "",
    !cut && typeof m.searchPosition === "number" && m.searchPosition > 0 ? `position ${m.searchPosition.toFixed(1)}` : "",
  ].filter(Boolean);
  if (!numbers.length) return words;
  const days = daysIn(window.from, window.to);
  return `${words}: ${numbers.join(", ")} ${days === 1 ? "on" : `in the ${days} days to`} ${dayWords(window.to)}`;
}

/**
 * A Search Console connection's searches (CONNECTORS_SEARCH_TEXT_ENABLED, ADR-0013), as the brand's
 * research: Google's counts over everyone who searched, not one person's words (decision 37). The
 * top 200 searches of the rolled 28 day doc, by clicks then impressions, each a part with its
 * clicks, impressions and position, never a page. Only viewers who may read the connection find
 * them (searchBrand), and its link opens the connection on Connected.
 */
export function searchConsoleSource(conn: Pick<DataConnection, "id" | "account">, doc: Pick<MetricSnapshot, "rows" | "window">): SearchSource | null {
  if (!doc.window) return null;
  const title = `Google searches: ${siteName(conn.account)}`;
  const url = `/admin/account/connections/connected?c=${conn.id}`;
  const seen = new Set<string>();
  const parts: NonNullable<SearchSource["parts"]> = [];
  for (const row of [...doc.rows].sort(compareRows)) {
    if (parts.length >= SEARCH_TEXT_TOP) break;
    const key = row.key.replace(/\s+/g, " ").trim().toLowerCase();
    const text = key && !seen.has(key) ? searchLine(row, doc.window) : null;
    if (!text) continue;
    seen.add(key);
    parts.push({ title, text, url });
  }
  return parts.length ? { kind: "research", ref: searchTextRef(conn.id), title, body: "", url, parts } : null;
}

/**
 * A Search Console connection's searches as a stub: once 28 days are collected (or all the site
 * has), so the first week's text isn't a partial window, and only while it is connected. Its version
 * is the ISO week of the last collected day, so the searches are read and embedded again once a
 * week, not every day the numbers move.
 */
export function searchConsoleStub(ctx: TenantContext, conn: DataConnection, deps: { db?: FirestoreLike } = {}): SearchStub | null {
  const c = conn.collect;
  if (conn.connectorId !== SEARCH_CONSOLE || conn.status !== "connected" || !conn.account) return null;
  if (!c?.lastDay || !c.backfilledTo || !c.rolledOn) return null;
  if (!c.filled && daysIn(c.backfilledTo, c.lastDay) < SEARCH_TEXT_DAYS) return null;
  const gen = c.gen;
  return {
    kind: "research",
    ref: searchTextRef(conn.id),
    version: isoWeekOf(c.lastDay),
    async load() {
      const doc = await readSnapshot(ctx, rolledId(conn.id, gen, SEARCH_CONSOLE_STREAM, "topic", "r28"), deps);
      return doc ? searchConsoleSource(conn, doc) : null;
    },
  };
}

/** Every Search Console connection's searches the brand keeps, while CONNECTORS_SEARCH_TEXT_ENABLED is on. */
export async function searchConsoleStubs(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<SearchStub[]> {
  if (!isConnectorsSearchTextEnabled()) return [];
  const conns = await forTenant(ctx, deps.db).dataConnections.find({ where: [["connectorId", "==", SEARCH_CONSOLE]], limit: 50 });
  return conns.map((c) => searchConsoleStub(ctx, c, deps)).filter((x): x is SearchStub => x !== null);
}

/**
 * One image look in use (IMAGE_STYLE_VERSIONS_ENABLED, learning loops step 4, 3.10): ref
 * `image_style.<style>@<version>`, as Forget removes it, so a look Forget drops leaves search at once
 * and a replaced version leaves it on the next sweep.
 */
export function imageLookSource(scope: string, v: number, words: string): SearchSource {
  const name = scope === BRAND_LOOK_SCOPE ? "Your brand's image look" : `${lookName(scope)} image look`;
  return {
    kind: "learned",
    ref: `${scope}@${v}`,
    title: `${name}, version ${v}`,
    body: lines(`What YouGrow learned from your votes for ${scope === BRAND_LOOK_SCOPE ? "your brand's images" : `${lookName(scope)} images`}:`, words),
    url: "/admin/brand-kit/image-style#learned",
  };
}

/** The image looks in use, read in the brand's region: none while versions are off. */
export async function imageLookStubs(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<SearchStub[]> {
  if (!isImageStyleVersionsOn()) return [];
  const pointers = await readBrandPointers(ctx, deps.db);
  const inUse = IMAGE_STYLE_SCOPES.map((scope) => ({ scope, v: pointers.scopes[scope]?.v ?? 0 })).filter((x) => x.v > 0);
  const rows = await Promise.all(inUse.map((x) => getPatternVersion(ctx, x.scope, x.v, deps.db)));
  const out: SearchStub[] = [];
  rows.forEach((row, i) => {
    const words = row?.items?.find((it) => it.type === "rule" && typeof it.text === "string" && it.text.trim())?.text?.trim();
    if (words) out.push(stubOf(imageLookSource(inUse[i]!.scope, inUse[i]!.v, words)));
  });
  return out;
}

/** One thing the autopilot learned from the brand's people (CREATE_AUTOPILOT_LEARNING_ENABLED). */
export function learnedSource(e: LearnedEntry): SearchSource {
  return { kind: "learned", ref: e.id, title: learnedLine(e).slice(0, 160), body: lines(learnedLine(e), e.at.slice(0, 10)), url: "/admin/brand-kit/map" };
}

/** A competitor's site summary, and what each of its articles covers (never their quotes or authors). */
export function competitorSources(c: Competitor, articles: CompetitorArticle[]): SearchSource[] {
  const url = `/admin/brand-kit/competitors/${c.id}`;
  const out: SearchSource[] = [];
  const summary = (c as { analysis?: { summary?: string } | null }).analysis?.summary;
  if (summary?.trim()) out.push({ kind: "competitor", ref: c.id, title: c.name, body: summary, url });
  for (const a of articles) {
    if (a.competitorId !== c.id) continue;
    const body = lines(s(a.summary), s(a.question) && `Answers: ${s(a.question)}`, s(a.angle) && `Angle: ${s(a.angle)}`);
    if (body) out.push({ kind: "competitor", ref: `${c.id}/${a.id}`, title: `${c.name}: ${a.title}`, body, url });
  }
  return out;
}

/** The latest finished map of a connected product's repo. */
export function repoMapSource(a: RepoAnalysis): SearchSource | null {
  const map = a.map as { summary?: string; facts?: Array<{ label?: string; description?: string }>; glossary?: Array<{ term?: string; definition?: string }>; events?: Array<{ label?: string; description?: string }> } | null | undefined;
  if (!map) return null;
  const body = lines(
    map.summary,
    list("Facts", (map.facts ?? []).map((f) => lines(f.label, f.description).replace(/\n\n/g, ": "))),
    list("Events", (map.events ?? []).map((e) => lines(e.label, e.description).replace(/\n\n/g, ": "))),
    list("Glossary", (map.glossary ?? []).map((g) => `${s(g.term)}: ${s(g.definition)}`)),
  );
  return body ? { kind: "repo_map", ref: a.connectionId, title: a.productName || "Product map", body, url: `/admin/products/${a.connectionId}` } : null;
}

export function imageSource(img: ImageAsset): SearchSource | null {
  const body = lines(img.prompt, img.brief);
  return body || img.title ? { kind: "image", ref: img.id, title: img.title || (img.prompt ?? "").slice(0, 80), body, url: "/admin/brand-kit/images" } : null;
}

// ── Reading a brand ─────────────────────────────────────────────────────────────────────────

/** Most knowledge chunks read from one source. */
const KNOWLEDGE_MAX_PER_SOURCE = 3000;

export interface BrandStubs {
  stubs: SearchStub[];
  /** The kinds read in full: only these may have records removed from the index. */
  complete: Set<SearchKind>;
}

/**
 * Every record the brand has, as stubs. A kind whose read fails is left out of `complete`, so
 * nothing of that kind is removed from the index on a bad read.
 */
export async function readBrandStubs(ctx: TenantContext): Promise<BrandStubs> {
  const stubs: SearchStub[] = [];
  const readOk = new Set<SearchKind>();
  const failed = new Set<SearchKind>();
  const repo = forTenant(ctx);
  // A kind fed by two reads is complete only when both worked.
  const read = async (kinds: SearchKind[], fn: () => Promise<SearchStub[]>) => {
    try {
      stubs.push(...(await fn()));
      for (const k of kinds) readOk.add(k);
    } catch (err) {
      for (const k of kinds) failed.add(k);
      console.warn(`[search] reading ${kinds.join(", ")} failed for ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  };
  const workspaces = await repo.workspaces.find({ limit: 200 });

  await read(["article", "newsletter", "ebook", "post", "journey_email"], async () => {
    const out: SearchStub[] = [];
    for (const ws of workspaces) for (const plan of await listContentPlans(ctx, ws.id, 500)) out.push(...contentPlanSources(plan).map(stubOf));
    return out;
  });
  await read(["idea_board", "template"], async () => {
    const out: SearchStub[] = [];
    for (const ws of workspaces) {
      for (const i of await listIdeaItems(ctx, ws.id, 500)) out.push(stubOf(ideaSource(i)));
      for (const t of await listTemplates(ctx, ws.id, 1000)) out.push(stubOf(templateSource(t)));
    }
    return out;
  });
  await read(["broadcast"], async () => (await repo.broadcasts.find({ limit: 1000 })).map((b) => stubOf(broadcastSource(b))));
  await read(["journey_email"], async () => (await listLifecycleJourneys(ctx)).flatMap(lifecycleSources).map(stubOf));
  await read(["brand_kit"], async () => {
    const tenant = await getTenantById(ctx.tenantId);
    const src = tenant ? brandKitSource(tenant, await repo.brandAuthors.find({ limit: 50 })) : null;
    return src ? [stubOf(src)] : [];
  });
  // Open questions come from the brand map and from the notes, so both are read together.
  await read(["subject", "question", "situation", "note"], async () => brandMapStubs(brandMapRecords(ctx), await listNotes(ctx)));
  await read(["research"], async () => {
    const imports = (await listImports(ctx)).map(importSource);
    const google = isBrandSignalsEnabled() ? (await readySignals(ctx, 1000)).map(signalSource) : [];
    // Off, none are listed, so the sweep removes what was indexed (research is read in full).
    const searches = await searchConsoleStubs(ctx);
    return [...[...imports, ...google].filter((x): x is SearchSource => x !== null).map(stubOf), ...searches];
  });
  await read(["learned"], async () => [
    ...(isAutopilotLearningEnabled() ? (await listLearned(ctx)).map((e) => stubOf(learnedSource(e))) : []),
    ...(await imageLookStubs(ctx)),
  ]);
  await read(["competitor"], async () => {
    const [competitors, articles] = await Promise.all([listCompetitors(ctx), listReadArticles(ctx)]);
    return competitors.flatMap((c) => competitorSources(c, articles)).map(stubOf);
  });
  await read(["repo_map"], async () => {
    const out: SearchStub[] = [];
    for (const conn of await repo.productConnections.find({ limit: 50 })) {
      const latest = (await listRepoAnalyses(ctx, conn.id)).find((a) => a.status === "done" || a.status === "incomplete");
      const src = latest ? repoMapSource(latest) : null;
      if (src) out.push(stubOf(src));
    }
    return out;
  });
  await read(["image"], async () => (await repo.imageAssets.find({ limit: 1000 })).map(imageSource).filter((x): x is SearchSource => x !== null).map(stubOf));
  await read(["knowledge"], async () => (await repo.ingestionTickets.find({ limit: 500 })).filter(isReadTicket).map((t) => knowledgeStub(ctx, t)));
  const complete = new Set([...readOk].filter((k) => !failed.has(k)));
  return { stubs, complete };
}

/**
 * The brand map's records on the map, and the notes and open questions. Reads only decided
 * records: that is all search keeps, and the brand-and-status query has an index on all three
 * record kinds (questions have none for the brand alone sorted by ref).
 */
export async function brandMapStubs(records: Pick<BrandMapRecordStore, "pageAll">, notes: BrandNote[]): Promise<SearchStub[]> {
  const out: SearchStub[] = [];
  for (const [kind, rk] of [["subject", "sub"], ["question", "q"], ["situation", "sit"]] as const) {
    for (const r of await records.pageAll(rk, { where: [["status", "==", "decided"]] })) {
      const src = brandMapSource(kind, r);
      if (src) out.push(stubOf(src));
    }
  }
  for (const n of notes) {
    const src = noteSource(n);
    if (src) out.push(stubOf(src));
  }
  return out;
}

function isReadTicket(t: IngestionTicket): boolean {
  return t.status === "done" || t.status === "partial";
}

/** One knowledge source: its chunks are read only when the source changed (a new crawl). */
export function knowledgeStub(ctx: TenantContext, t: IngestionTicket): SearchStub {
  return {
    kind: "knowledge",
    ref: t.id,
    version: contentHash("knowledge", t.status, t.finishedAt ?? "", String(t.chunksWritten), t.sourceUri),
    async load() {
      const chunks = await readKnowledgeChunkTexts(ctx, t.ownerKind, t.ownerId, { ticketId: t.id, max: KNOWLEDGE_MAX_PER_SOURCE });
      if (!chunks.length) return null;
      return {
        kind: "knowledge",
        ref: t.id,
        title: t.sourceUri,
        body: "",
        url: t.sourceUri,
        parts: chunks.map((c) => ({ title: [c.title, c.heading].filter(Boolean).join(": "), text: c.content, url: c.sourceUri || t.sourceUri })),
      };
    },
  };
}
