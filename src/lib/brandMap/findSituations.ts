import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateGroundedText, isGeminiConfigured } from "@/lib/agents/gemini";
import type { RetrievedChunk } from "@/lib/agents/knowledgeRetrieval";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { siteOf } from "@/lib/knowledge/site";
import { blogResearchThinkingBudget } from "@/lib/content/blog/flags";
import { sourcesBacking } from "@/lib/content/blog/research";
import { BRAND_MAP_RECORD_LIMITS as LIMITS, BrandMapSituationSchema, type BrandMapSituation, type SituationSide, type SituationW } from "@/lib/types/brandMapRecords";
import type { KnownPage } from "@/lib/content/blog/links";
import { NAME_KIND_LABEL } from "./changes";
import { embedSituations, type EmbedDeps } from "./embed";
import { createOnce } from "./createOnce";
import { freshId, situationIdFor, situationKey } from "./keys";
import { gatherBrandMaterial, type ProposeDeps } from "./research";
import { parseSituation } from "./situations";
import { readBrandMap } from "./store";
import { clean, fence, hasAddress, oneLine } from "./lineChecks";

/**
 * Research's first step for buying situations (BRAND_MAP_SITUATIONS_ENABLED): ONE grounded
 * call reads the brand's own pages and knowledge passages (numbered), its articles' questions,
 * an optional line about what made its last customers start looking, and the situations it
 * has or turned down, then searches forums, reviews and searches for the moments that make
 * people start looking, walking the W's from the business and the professional side.
 *
 * Code keeps the last word, as research's other steps:
 *  - any line holding an address is dropped; the model never writes a link;
 *  - a situation is backed only by numbers that name the brand's own pages or passages;
 *    one with none arrives unticked, marked as not backed (never silently dropped);
 *  - "seen on the web" is the title and domain of the search's own sources for that line
 *    (`sourcesBacking`), never something the model says;
 *  - one the brand has, or a person dismissed, is never proposed again.
 * What it finds is PROPOSED: nothing is on the map until a person adds it.
 */

const MAX_PASSAGES = 12;
const PASSAGE_CHARS = 600;
const MAX_HAVE = 300;
const MAX_CUSTOMERS = 300;


const W_WORDS: Record<string, SituationW> = {
  why: "why",
  when: "when",
  while: "while",
  where: "where",
  with_whom: "with_whom",
  whom: "with_whom",
  with_what: "with_what",
  feeling: "feeling",
  feelings: "feeling",
  how_it_feels: "feeling",
  how_they_feel: "feeling",
};

export interface FoundSituation {
  text: string;
  w: SituationW;
  wText: string;
  who: string;
  side: SituationSide;
  want: string;
  feel: string;
  /** The brand's own pages (P) and passages (K) it named, by number. */
  backing: Array<{ kind: "P" | "K"; n: number }>;
}

/** The answer's SITUATION lines, each once (by its words), at most `max`. */
export function parseSituationLines(text: string, max: number = LIMITS.runSituations): FoundSituation[] {
  const out: FoundSituation[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**SITUATION\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m || hasAddress(raw)) continue;
    const parts = (m[1] ?? "").split(/\s*\|\s*/).map(clean);
    const words = (parts[0] ?? "").slice(0, LIMITS.situationText);
    const key = situationKey(words);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const part = (i: number) => {
      const p = parts[i] ?? "";
      return /^(none|n\/a|-|unknown)$/i.test(p) ? "" : p.slice(0, LIMITS.situationPart);
    };
    out.push({
      text: words,
      w: W_WORDS[(parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_")] ?? "why",
      wText: part(2),
      who: part(3),
      side: /prof/i.test(parts[4] ?? "") ? "professional" : "business",
      want: part(5),
      feel: part(6),
      backing: [...(parts[7] ?? "").matchAll(/\b([PK])\s*(\d{1,3})\b/gi)].map((x) => ({ kind: (x[1] ?? "P").toUpperCase() as "P" | "K", n: Number(x[2]) })),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** What of the brand's own a situation's numbers name: real pages and passages only. */
export function backingOf(found: FoundSituation, pages: KnownPage[], passages: RetrievedChunk[], own: Set<string>): BrandMapSituation["backedBy"] {
  const out: BrandMapSituation["backedBy"] = [];
  const seen = new Set<string>();
  for (const b of found.backing) {
    const key = `${b.kind}${b.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (b.kind === "P") {
      const page = pages[b.n - 1];
      if (page) out.push({ kind: "page", label: oneLine(page.title || new URL(page.url).pathname).slice(0, LIMITS.label), url: page.url });
    } else {
      const chunk = passages[b.n - 1];
      if (!chunk) continue;
      const label = oneLine([chunk.title, chunk.heading].filter(Boolean).join(" — ") || "A passage in your knowledge").slice(0, LIMITS.label);
      // A link only to the brand's own site.
      const url = /^https:\/\//i.test(chunk.sourceUri) && own.has(siteOf(chunk.sourceUri)) ? chunk.sourceUri.slice(0, 300) : undefined;
      out.push({ kind: "knowledge", label, ...(url ? { url } : {}) });
    }
    if (out.length >= LIMITS.backedBy) break;
  }
  return out;
}

const bareDomain = (s: string) => {
  const d = s.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) && d.length <= 253 ? d : "";
};

export interface FindDeps extends ProposeDeps {
  nowMs?: number;
  grounded?: typeof generateGroundedText;
  embed?: Omit<EmbedDeps, "db" | "nowMs">;
}

export type FindResult =
  | { ok: true; found: BrandMapSituation[]; skipped: number; notes: string[] }
  | { ok: false; status: number; error: string };

export async function findSituations(ctx: TenantContext, input: { customers?: string; timeoutMs?: number }, deps: FindDeps = {}): Promise<FindResult> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const clock = deps.now ?? (() => new Date(deps.nowMs ?? Date.now()));
  const deadline = clock().getTime() + (input.timeoutMs ?? 60_000);
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (read?.state === "unreadable") return { ok: false, status: 409, error: "map_unreadable" };
  const map = read?.state === "ok" ? read.map : null;
  const identity = map?.identity;

  const store = brandMapRecords(ctx, deps.db);
  const have = (await store.pageAll("sit", { fields: ["text", "textKey", "status"] }).catch(() => [])).filter((r) => typeof r.text === "string");
  if (have.length >= LIMITS.situations) return { ok: false, status: 409, error: "too_many_situations" };
  const haveKeys = new Set(have.map((r) => (typeof r.textKey === "string" && r.textKey ? r.textKey : situationKey(String(r.text)))));

  const m = await gatherBrandMaterial(
    ctx,
    { name: identity?.name ?? "", site: identity?.site ?? "" },
    (name) => `What problems does ${name || "this brand"} solve, for whom, and when do people need it?`,
    deps,
  );
  const passages = m.knowledge.flatMap((k) => k?.chunks ?? []).slice(0, MAX_PASSAGES);
  if (!passages.length && !m.siteText && !m.pages.length) return { ok: false, status: 409, error: "nothing_to_read" };

  const said = [
    identity?.name ? `Name: ${identity.name}` : m.brandName ? `Name: ${m.brandName}` : "",
    identity?.category ? `Category: ${identity.category}` : "",
    identity?.statement ? `What it is: ${identity.statement}` : "",
    ...(map?.names ?? []).filter((n) => n.kind !== "alternative").slice(0, 30).map((n) => `${NAME_KIND_LABEL[n.kind]}: ${n.name}`),
  ].filter(Boolean);
  const prompt = renderPrompt("brand.map_situations", {
    brand_name: m.brandName.replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
    site: m.site || "(no website set)",
    today: clock().toISOString().slice(0, 10),
    identity: fence("brand", said.join("\n") || "(not set yet)"),
    own_pages: fence("own_pages", m.pages.map((p, i) => `P${i + 1}. ${p.title || "(untitled)"} — ${new URL(p.url).pathname}`).join("\n") || "(none)"),
    passages: fence(
      "knowledge",
      passages.map((c, i) => `K${i + 1}. ${oneLine([c.title, c.heading].filter(Boolean).join(" — "))}: ${oneLine(c.content).slice(0, PASSAGE_CHARS)}`).join("\n") || "(none)",
    ),
    existing: fence("articles", m.existing.filter((l) => l.startsWith("Q:")).join("\n") || "(none yet)"),
    customers: fence("customers", oneLine(input.customers ?? "").slice(0, MAX_CUSTOMERS)),
    have: fence("have", have.slice(0, MAX_HAVE).map((r) => `- ${oneLine(String(r.text))}`).join("\n") || "(none yet)"),
    max: LIMITS.runSituations,
  });
  const left = deadline - clock().getTime() - 3_000;
  if (left < 15_000) return { ok: false, status: 504, error: "research_failed" };
  const answer = await (deps.grounded ?? generateGroundedText)(prompt, { timeoutMs: left, thinkingBudget: blogResearchThinkingBudget() }).catch(() => null);
  const lines = parseSituationLines(answer?.text ?? "");
  if (!answer || !lines.length) return { ok: false, status: 502, error: "research_failed" };

  const now = clock().toISOString();
  const found: BrandMapSituation[] = [];
  let skipped = 0;
  let order = have.length;
  for (const line of lines) {
    const key = situationKey(line.text);
    // The brand has it already, or a person turned it down.
    if (haveKeys.has(key)) {
      skipped += 1;
      continue;
    }
    if (have.length + found.length >= LIMITS.situations) break;
    const backedBy = backingOf(line, m.pages, passages, m.own);
    const seen = [
      ...new Map(
        sourcesBacking(line.text, answer.text, answer.supports)
          .map((i) => answer.sources[i])
          .flatMap((s) => {
            const domain = s ? bareDomain(s.domain || s.title) : "";
            return s && domain && !m.own.has(siteOf(`https://${domain}`)) ? [[domain, { title: oneLine(s.title === s.domain ? "" : s.title).slice(0, LIMITS.label), domain }] as const] : [];
          }),
      ).values(),
    ].slice(0, LIMITS.seen);
    const parsed = BrandMapSituationSchema.safeParse({
      id: situationIdFor(ctx.tenantId, line.text),
      tenantId: ctx.tenantId,
      status: "proposed",
      from: "research",
      reason: backedBy.length ? "Found by research" : "Found by research; nothing of yours backs it yet",
      evidence: seen.length ? `Seen on ${seen.length} page${seen.length === 1 ? "" : "s"} on the web` : "",
      createdAt: now,
      updatedAt: now,
      text: line.text,
      textKey: key,
      w: line.w,
      wText: line.wText,
      who: line.who,
      side: line.side,
      want: line.want,
      feel: line.feel,
      backed: backedBy.length > 0,
      backedBy,
      seen,
      order: order++,
    });
    if (!parsed.success) continue;
    const { id, tenantId: _t, ...data } = parsed.data;
    void _t;
    const once = await createOnce(store, "sit", id, data, { same: (there) => there.textKey === key, fresh: () => freshId("sit") });
    // Found at the same moment by another run: not proposed twice.
    if (once.existing) {
      skipped += 1;
      continue;
    }
    const situation = parseSituation(once.created);
    if (situation) {
      found.push(situation);
      haveKeys.add(key);
    }
  }
  await embedSituations(ctx, found, { db: deps.db, ...deps.embed }).catch(() => 0);
  const unbacked = found.filter((s) => !s.backed).length;
  const notes = [
    ...(unbacked ? [`${unbacked} of them ${unbacked === 1 ? "isn't" : "aren't"} backed by your site or knowledge: they arrive unticked.`] : []),
    ...(!passages.length ? ["None of your programmes has knowledge to read yet, so only your pages could back a situation."] : []),
  ];
  return { ok: true, found, skipped, notes };
}
