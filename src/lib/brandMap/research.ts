import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateGroundedText, isGeminiConfigured } from "@/lib/agents/gemini";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { siteOf, sitesOf, tenantDomains } from "@/lib/knowledge/site";
import { indexedSitePages } from "@/lib/knowledge/sitePages";
import { fetchHomepage, type Homepage } from "@/lib/content/create/homepage";
import { stripFenceDelimiters } from "@/lib/content/create/siteText";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { blogResearchThinkingBudget } from "@/lib/content/blog/flags";
import { isLinkablePage, linkIntent, type KnownPage } from "@/lib/content/blog/links";
import { BlogIntent } from "@/lib/types/contentPlan";
import { BRAND_MAP_LIMITS, BrandMapChangeSchema, BrandMapNameKind, type BrandMapChange, type BrandMapDecided } from "@/lib/types/brandMap";
import { findName, findSubject, fold } from "./changes";
import { profileLinksFromHtml } from "./profileLinks";
import type { SuggestionInput } from "./store";

/**
 * Research that drafts the brand map (BRAND_MAP_RESEARCH_ENABLED). It reads what the brand
 * says about itself (its knowledge base, its home page, the pages it has indexed, the names
 * its articles already use) and searches how buyers talk about its category, in ONE
 * search-grounded call. Everything it finds becomes a SUGGESTION: nothing is decided here.
 *
 * Code keeps the last word:
 *  - the model never writes an address: a subject's or name's home is a page NUMBER from
 *    the brand's own pages, and any line holding a link is dropped;
 *  - a product or an integration is kept only if the brand's own material names it;
 *  - a name to avoid is kept only with a name to use instead that the map already has;
 *  - what a person decided is never replaced, only gaps are filled;
 *  - profile links come from the brand's own home page, never from the model.
 */

const UA = "Vizzybl-BrandMap/1.0";
const MAX_WORKSPACES = 4;
const MAX_KNOWLEDGE_WORKSPACES = 3;
const MAX_PAGES = 100;
const MAX_KNOWLEDGE_CHARS = 9_000;
const MAX_SITE_TEXT = 6_000;
const MAX_EXISTING = 40;
const LIMIT = { subjects: 5, questions: 6, alternatives: 8, products: 8, names: 30, isNot: 3, avoid: 3 } as const;
/** HOME lines read from one answer. */
const MAX_HOMES = 40;

export interface MapProposal {
  is: string;
  category: string;
  not: string[];
  avoid: Array<{ term: string; useInstead: string }>;
  subjects: Array<{ name: string; questions: Array<{ text: string; intent: BlogIntent }> }>;
  names: Array<{ name: string; kind: BrandMapNameKind; aliases: string[] }>;
  homes: Array<{ label: string; n: number }>;
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”'*]+|["“”'*]+$/g, "").trim();
const hasAddress = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|dev|app)\/\S/i.test(s);

/** Read the research answer. Unknown lines are skipped, and so is any line with an address in it. */
export function parseMapProposal(text: string): MapProposal {
  const out: MapProposal = { is: "", category: "", not: [], avoid: [], subjects: [], names: [], homes: [] };
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**(IS|CATEGORY|NOT|AVOID|SUBJECT|Q|NAME|HOME)\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m || hasAddress(raw)) continue;
    const kind = (m[1] ?? "").toUpperCase();
    // "Name | kind |" with nothing after the last bar is still a line: empty parts at the end go.
    const parts = (m[2] ?? "").split(/\s*\|\s*/).map(clean);
    while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
    const head = parts[0] ?? "";
    if (!head) continue;
    if (kind === "IS") out.is ||= head.slice(0, 300);
    else if (kind === "CATEGORY") out.category ||= head.slice(0, 80);
    else if (kind === "NOT") out.not.push(head.slice(0, 120));
    else if (kind === "AVOID") out.avoid.push({ term: head.slice(0, 60), useInstead: (parts[1] ?? "").slice(0, 60) });
    else if (kind === "SUBJECT") out.subjects.push({ name: head.slice(0, 80), questions: [] });
    else if (kind === "Q") {
      const subject = out.subjects[out.subjects.length - 1];
      if (!subject) continue;
      const intent = BlogIntent.safeParse((parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
      subject.questions.push({ text: head.slice(0, 200), intent: intent.success ? intent.data : "other" });
    } else if (kind === "NAME") {
      const k = BrandMapNameKind.safeParse((parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
      if (!k.success) continue;
      const aliases = (parts[2] ?? "")
        .split(";")
        .map(clean)
        .filter((a) => a && fold(a) !== fold(head) && !/^(none|n\/a|-)$/i.test(a))
        .slice(0, 4);
      out.names.push({ name: head.slice(0, 80), kind: k.data, aliases });
    } else if (kind === "HOME") {
      const n = Number(/^\D*(\d{1,3})\D*$/.exec(parts[1] ?? "")?.[1]);
      if (Number.isInteger(n) && n > 0) out.homes.push({ label: head.slice(0, 80), n });
    }
  }
  return out;
}

/** Whole words of `name` appear in `text` (both folded). */
function mentions(text: string, name: string): boolean {
  const n = fold(name);
  if (!n) return false;
  return ` ${text} `.includes(` ${n} `);
}

export interface ProposalContext {
  current: BrandMapDecided;
  /** The brand's own words: knowledge, home page, own page titles, rows a person typed on briefs. Folded. */
  firstParty: string;
  /** The numbered own pages the prompt listed (1-based). */
  pages: KnownPage[];
  /** Profile links found on the home page. */
  profiles: string[];
  brandName: string;
  site: string;
}

/** Turn what research found into suggestions, keeping only what code can stand behind. */
export function checkProposal(p: MapProposal, ctx: ProposalContext): SuggestionInput[] {
  const items: SuggestionInput[] = [];
  const add = (change: unknown, extra: Omit<SuggestionInput, "change"> = {}) => {
    const parsed = BrandMapChangeSchema.safeParse(change);
    if (parsed.success) items.push({ change: parsed.data, ...extra });
  };
  const id = ctx.current.identity;
  if (!id.name && ctx.brandName) add({ type: "set_identity", field: "name", value: ctx.brandName }, { reason: "Your account's name", evidence: "site" });
  if (!id.site && ctx.site) add({ type: "set_identity", field: "site", value: ctx.site }, { reason: "Your account's domain", evidence: "site" });
  if (!id.statement && p.is) add({ type: "set_identity", field: "statement", value: p.is }, { reason: "From your site", evidence: "site" });
  const category = id.category || p.category;
  if (!id.category && p.category) add({ type: "set_identity", field: "category", value: p.category }, { reason: "How buyers name your category", evidence: "search" });
  for (const text of p.not.slice(0, LIMIT.isNot)) add({ type: "add_is_not", text }, { inferred: true, reason: "Inferred: check it", evidence: "search" });

  // Subjects and their questions, a subject before its questions.
  let subjects = 0;
  for (const s of p.subjects) {
    if (subjects >= LIMIT.subjects) break;
    subjects += 1;
    add({ type: "add_subject", name: s.name }, { reason: "A subject buyers ask about", evidence: "search" });
    let compares = 0;
    for (const q of s.questions.slice(0, LIMIT.questions)) {
      if (q.intent === "comparison" || q.intent === "alternatives") {
        if (compares >= 2) continue;
        compares += 1;
      }
      add({ type: "add_question", subject: s.name, text: q.text, intent: q.intent }, { reason: "Asked by buyers", evidence: "search" });
    }
  }

  // Names: the brand's own only as its material names them; alternatives capped.
  const kept: MapProposal["names"] = [];
  let alternatives = 0;
  let products = 0;
  for (const n of p.names) {
    if (kept.length >= LIMIT.names) break;
    if (fold(n.name) === fold(ctx.brandName) || fold(n.name) === fold(category)) continue;
    if ((n.kind === "product" || n.kind === "integration") && ![n.name, ...n.aliases].some((x) => mentions(ctx.firstParty, x))) continue;
    if (n.kind === "alternative" && (alternatives += 1) > LIMIT.alternatives) continue;
    if (n.kind === "product" && (products += 1) > LIMIT.products) continue;
    kept.push(n);
    add(
      { type: "add_name", name: n.name, kind: n.kind, aliases: n.aliases },
      { reason: n.kind === "product" || n.kind === "integration" ? "Named on your site" : n.kind === "alternative" ? "An alternative buyers compare" : "From your site and search", evidence: n.kind === "product" || n.kind === "integration" ? "site" : "search" },
    );
  }

  // A name to avoid needs a name to use instead that the map has (or is being given).
  const usable = new Set(
    [category, ctx.brandName, id.name, ...kept.filter((n) => n.kind === "product").map((n) => n.name), ...ctx.current.names.filter((n) => n.kind === "product").map((n) => n.name)]
      .map(fold)
      .filter(Boolean),
  );
  for (const a of p.avoid.slice(0, LIMIT.avoid)) {
    if (!usable.has(fold(a.useInstead)) || usable.has(fold(a.term))) continue;
    add({ type: "add_avoid", term: a.term, useInstead: a.useInstead }, { inferred: true, reason: "Inferred: check it", evidence: "search" });
  }

  // Homes, by page number only, for a subject or one of the brand's own names.
  const subjectNames = new Set([...p.subjects.slice(0, LIMIT.subjects).map((s) => fold(s.name)), ...ctx.current.subjects.map((s) => fold(s.name))]);
  for (const h of p.homes.slice(0, MAX_HOMES)) {
    const page = ctx.pages[h.n - 1];
    if (!page) continue;
    const label = fold(h.label);
    if (subjectNames.has(label)) {
      const current = findSubject(ctx.current, h.label);
      if (current?.home) continue;
      add({ type: "set_home", target: "subject", name: h.label, url: page.url }, { reason: "A page on your site", evidence: "site" });
      continue;
    }
    const own = kept.find((n) => fold(n.name) === label && n.kind !== "alternative") ?? findName(ctx.current, h.label);
    if (!own || ("home" in own && own.home)) continue;
    add({ type: "set_home", target: "name", name: own.name, url: page.url }, { reason: "A page on your site", evidence: "site" });
  }

  for (const url of ctx.profiles) add({ type: "add_profile", url, source: "site" }, { reason: "Linked from your home page", evidence: "site" });
  // Research keeps at most this many rows: past it, the store would drop the first (the brand's
  // name, category and statement), so the last are left out instead.
  return items.slice(0, BRAND_MAP_LIMITS.suggestions.research);
}

/** The current map, one line each, for the prompt. */
function describeMap(d: BrandMapDecided): string {
  const lines: string[] = [];
  const i = d.identity;
  if (i.name) lines.push(`Name: ${i.name}`);
  if (i.category) lines.push(`Category: ${i.category}`);
  if (i.statement) lines.push(`What it is: ${i.statement}`);
  for (const t of i.isNot) lines.push(`It is not: ${t}`);
  for (const a of i.avoid) lines.push(`Avoid: ${a.term}${a.useInstead ? ` (say ${a.useInstead})` : ""}`);
  for (const s of d.subjects) {
    lines.push(`Subject: ${s.name}`);
    for (const q of s.questions) lines.push(`  Question: ${q.text}`);
  }
  for (const n of d.names) lines.push(`Name: ${n.name} (${n.kind})`);
  return lines.join("\n") || "(empty — nothing decided yet)";
}

const fence = (tag: string, text: string) => text.replace(new RegExp(`</?\\s*${tag}[^>]*>`, "gi"), " ");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Rank own pages: the ones that convert or describe the product first, then the shallow ones. */
const INTENT_ORDER = ["convert", "product", "proof", "compare", "learn"];
function rankPages(pages: KnownPage[], own: Set<string>): KnownPage[] {
  const seen = new Set<string>();
  const out: KnownPage[] = [];
  for (const p of pages) {
    const url = normalizeUrl(p.url);
    if (!url || seen.has(url) || !isLinkablePage(url) || !own.has(siteOf(url))) continue;
    seen.add(url);
    out.push({ url, title: oneLine(p.title).slice(0, 120) });
  }
  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  return out
    .sort((a, b) => INTENT_ORDER.indexOf(linkIntent(a.url, a.title)) - INTENT_ORDER.indexOf(linkIntent(b.url, b.title)) || depth(a.url) - depth(b.url))
    .slice(0, MAX_PAGES);
}

/** Wait for `work`, or give up after `ms` with `fallback`. */
function soft<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export interface ProposeDeps {
  db?: FirestoreLike;
  /** The brand's programmes (workspaces). */
  workspaces?: (ctx: TenantContext) => Promise<Array<{ id: string; archivedAt?: string | null; updatedAt?: string }>>;
  grounded?: typeof generateGroundedText;
  modelReady?: () => boolean;
  retrieve?: typeof retrieveSemanticKnowledgeContext;
  sitePages?: typeof indexedSitePages;
  fetchHome?: (domain: string) => Promise<Homepage | null>;
  plans?: typeof listContentPlans;
  now?: () => Date;
}

export type ProposeResult =
  | { ok: true; items: SuggestionInput[]; notes: string[] }
  | { ok: false; status: number; error: string };

export async function proposeBrandMap(
  ctx: TenantContext,
  args: { current: BrandMapDecided; timeoutMs?: number },
  deps: ProposeDeps = {},
): Promise<ProposeResult> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const clock = deps.now ?? (() => new Date());
  const started = clock().getTime();
  const deadline = started + (args.timeoutMs ?? 60_000);
  const notes: string[] = [];

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const brandName = oneLine(args.current.identity.name || tenant?.tenantName || "");
  const domains = tenantDomains(tenant);
  const own = sitesOf([args.current.identity.site, ...domains]);
  const root = (tenant?.rootDomain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const site = args.current.identity.site || (root ? `https://${root}` : "");

  const listWorkspaces = deps.workspaces ?? ((c: TenantContext) => forTenant(c, deps.db).workspaces.find({ where: [], limit: 200 }));
  const workspaces = (await listWorkspaces(ctx).catch(() => []))
    .filter((w) => !w.archivedAt)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_WORKSPACES);

  const retrieve = deps.retrieve ?? retrieveSemanticKnowledgeContext;
  const question = `What is ${brandName || "this brand"}, what does it do, who is it for, and what category is it in?`;
  const [pageLists, knowledge, planLists, home] = await Promise.all([
    Promise.all(workspaces.map((w) => soft((deps.sitePages ?? indexedSitePages)(ctx, w.id), 8_000, { pages: [], repoPaths: [] }))),
    Promise.all(
      workspaces.slice(0, MAX_KNOWLEDGE_WORKSPACES).map((w) =>
        soft(retrieve({ ctx, ownerKind: "workspace", ownerId: w.id, queryText: question, limit: 6, bypassEnabledFlag: true }), 8_000, null),
      ),
    ),
    Promise.all(workspaces.map((w) => soft((deps.plans ?? listContentPlans)(ctx, w.id, 30), 8_000, []))),
    root ? soft((deps.fetchHome ?? ((d: string) => fetchHomepage(d, { userAgent: UA, maxTextChars: MAX_SITE_TEXT })))(root), 8_000, null) : Promise.resolve(null),
  ]);

  const pages = rankPages(pageLists.flatMap((l) => l.pages), own);
  const knowledgeText = knowledge
    .map((k) => k?.formatted ?? "")
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_KNOWLEDGE_CHARS);
  const siteText = stripFenceDelimiters(home?.text ?? "").slice(0, MAX_SITE_TEXT);
  if (!knowledgeText && !siteText) return { ok: false, status: 409, error: "nothing_to_read" };
  if (!root) notes.push("Your account has no website domain, so no home pages or profile links were found. Set it in Settings.");
  if (!pages.length) notes.push("None of your programmes has crawled your site yet, so no subject or name has a home page.");

  const briefs = planLists.flat().flatMap((p) => (p.blog ? [p.blog] : []));
  const typedNames = briefs.flatMap((b) => b.entities.filter((e) => e.by === "operator").map((e) => e.name));
  const existing = [
    ...new Set([
      ...briefs.flatMap((b) => b.entities.map((e) => `NAME: ${oneLine(e.name)} (${e.relation})`)),
      ...briefs.flatMap((b) => [b.primaryQuestion, ...b.questions.map((q) => q.question)].filter(Boolean).map((q) => `Q: ${oneLine(q)}`)),
    ]),
  ].slice(0, MAX_EXISTING * 2);

  const prompt = renderPrompt("brand.map_research", {
    brand_name: brandName.replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
    site: site || "(no website set)",
    today: clock().toISOString().slice(0, 10),
    current_map: fence("current_map", describeMap(args.current)),
    own_pages: fence("own_pages", pages.map((p, i) => `${i + 1}. ${p.title || "(untitled)"} — ${new URL(p.url).pathname}`).join("\n") || "(none)"),
    knowledge_context: fence("brand_material", knowledgeText),
    site_text: fence("brand_material", siteText),
    existing: fence("articles", existing.join("\n") || "(none yet)"),
    voice: oneLine(tenant?.brandVoice?.summary ?? "").slice(0, 500) || "(not set)",
  });
  const left = deadline - clock().getTime() - 3_000;
  if (left < 15_000) return { ok: false, status: 504, error: "research_failed" };
  const answer = await (deps.grounded ?? generateGroundedText)(prompt, { timeoutMs: left, thinkingBudget: blogResearchThinkingBudget() }).catch(() => null);
  const proposal = parseMapProposal(answer?.text ?? "");
  const found = proposal.is || proposal.category || proposal.subjects.length || proposal.names.length;
  if (!found) return { ok: false, status: 502, error: "research_failed" };

  const firstParty = fold([knowledgeText, siteText, ...pages.map((p) => p.title), ...typedNames].join("\n"));
  const profiles = home ? profileLinksFromHtml(home.html, home.baseUrl, [...domains, site]) : [];
  const items = checkProposal(proposal, { current: args.current, firstParty, pages, profiles, brandName, site });
  return { ok: true, items, notes: notes.slice(0, 5) };
}

/** A research change, for a summary: "4 subjects with 17 questions, 12 names, 3 profile links". */
export function summarise(changes: BrandMapChange[]): string {
  const count = (t: BrandMapChange["type"]) => changes.filter((c) => c.type === t).length;
  const parts = [
    changes.some((c) => c.type === "set_identity" || c.type === "add_is_not" || c.type === "add_avoid") ? "what you are" : "",
    count("add_subject") ? `${count("add_subject")} subject${count("add_subject") === 1 ? "" : "s"} with ${count("add_question")} question${count("add_question") === 1 ? "" : "s"}` : "",
    count("add_name") ? `${count("add_name")} name${count("add_name") === 1 ? "" : "s"}` : "",
    count("add_profile") ? `${count("add_profile")} profile link${count("add_profile") === 1 ? "" : "s"}` : "",
    count("set_home") ? `${count("set_home")} home page${count("set_home") === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
