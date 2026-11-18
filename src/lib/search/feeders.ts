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
import { listLifecycleJourneys } from "@/lib/lifecycle/service";
import { listRepoAnalyses } from "@/lib/connect/repoAnalysis";
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
import { contentHash } from "./text";
import type { SearchKind, SearchSource, SearchStub } from "./types";

/**
 * What a brand wrote, read through the tenant layer, as search sources. Each kind has a pure
 * mapper (tested without a database) and is read by readBrandStubs. People's words (sign-up
 * answers, AI conversations, social comments, person plans) are not read: they wait for the data
 * processing agreement. Notes that may name a real customer (canName) are left out for the same
 * reason, and so are competitor quotes and authors.
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

export function ideaSource(idea: IdeaItem): SearchSource {
  return {
    kind: "idea",
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
  await read(["idea", "template"], async () => {
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
  await read(["research"], async () => (await listImports(ctx)).map(importSource).filter((x): x is SearchSource => x !== null).map(stubOf));
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
