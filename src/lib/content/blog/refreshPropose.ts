import { syncPlanPageSoftly } from "./pageActions";
import { pinOriginal } from "@/lib/content/create/aiOriginals";
import { createHash } from "node:crypto";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan, updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { ArticleReviewDoc, ProposalKind, ReviewEvidence, ReviewProposal } from "@/lib/types/articleRefresh";
import { BlogSourceSchema, type BlogArticleFreshness, type BlogBrief, type BlogSource, type ContentNode } from "@/lib/types/contentPlan";
import { articleFigures, figureSet, wordsOf } from "./figures";
import { articleFreshness, nextEvents } from "./freshness";
import { checkPlanBlogFacts } from "./hubActions";
import { inlineLinks } from "./markdown";
import { leaveDueList, markChecked } from "./refreshAdmin";
import { reviewId } from "./refreshHold";
import { readReview, type StepFn, type StepResult } from "./refreshReview";
import { saveVersion } from "./versions";
import { recordDecision } from "./refreshRecords";
import { inBrandLanguage } from "@/lib/i18n/writingLanguage";

/**
 * Article refresh's last step and what a person does with it (BLOG_REFRESH_ENABLED). One model
 * call proposes at most 8 changes, each tied to evidence the review found; code checks every one
 * and drops what fails. Dead and moved links are proposed by code alone. Apply changes the copy in
 * code (no model rewrites the rest), keeps the copy it replaces as a version, adds new sources to
 * the brief, runs the fact check again and sends the article back for approval. Only a change to
 * the words is a real update that moves Updated: Google's rule against freshening dates.
 */

export const PROPOSE = {
  MAX: 8,
  /**
   * The model call: a whole article and its evidence, like the fact check's (75s). 40s with
   * thinking uncapped ran out on dev's first real article (25 Nov), so thinking is capped too.
   */
  TIMEOUT_MS: 70_000,
  THINKING_BUDGET: 2048,
  /** The most a review may add, in words: this share of the article, and never more than MAX_WORDS. */
  GROWTH: 0.25,
  MAX_WORDS: 600,
  SECTION_MIN_WORDS: 30,
  SECTION_MAX_WORDS: 200,
} as const;

const MODEL_KINDS = new Set<ProposalKind>(["newer_figure", "answer_search", "new_question", "product_fact", "note"]);
/** Which evidence a kind may stand on. */
const STANDS_ON: Record<ProposalKind, ReviewEvidence["kind"][]> = {
  newer_figure: ["new_fact", "source_changed"],
  answer_search: ["page_search", "new_question", "open_question"],
  new_question: ["new_question", "open_question", "page_search"],
  product_fact: ["product_fact"],
  note: ["note"],
  dead_source: ["dead_link"],
  source_link: ["source_moved"],
};
/** The closing sections a new section goes before, when it names none to follow. */
const CLOSING = /^##\s+(sources|references|faq|frequently asked questions|next step|the bottom line|bottom line)\b/i;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const occurrences = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);
const stripLinks = (t: string) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "");
const isHeadingOrDate = (t: string) => /^\s*#/.test(t) || /last updated|^\s*\*?published\b/i.test(t);

export function fingerprintOf(kind: ProposalKind, evidence: ReviewEvidence[]): string {
  const keys = evidence.map((e) => `${e.kind}|${(e.url ?? "").toLowerCase()}|${e.text.toLowerCase().replace(/\s+/g, " ").slice(0, 200)}`).sort();
  return createHash("sha256").update(`${kind}#${keys.join("#")}`).digest("hex").slice(0, 16);
}

/** The words change, not only a link: applying it moves Updated. */
export function isRealChange(old: string | null, next: string): boolean {
  const a = [...wordsOf(stripLinks(old ?? ""))].sort().join(" ");
  const b = [...wordsOf(stripLinks(next))].sort().join(" ");
  return a !== b;
}

/** A source a proposal cites, from the new_fact it stands on. */
function sourceOf(e: ReviewEvidence): ReviewProposal["source"] {
  if (e.kind !== "new_fact" || !e.url) return null;
  const publisher = e.detail.split(",")[0]?.trim() ?? "";
  return { url: e.url, title: publisher, publisher, year: e.year, fact: e.text };
}

export interface Candidate {
  kind: string;
  old: string | null;
  new: string;
  after: string | null;
  evidence: string[];
  why: string;
}

/**
 * Check one proposed change against the copy and its evidence. Null when it fails: the reason is
 * logged for us, never shown, as a person only ever sees changes that passed.
 */
export function checkProposal(body: string, c: Candidate, evidence: Map<string, ReviewEvidence>, dismissed: Set<string>, id: string): ReviewProposal | null {
  const kind = c.kind as ProposalKind;
  if (!MODEL_KINDS.has(kind)) return null;
  const used = c.evidence.map((x) => evidence.get(x)).filter((e): e is ReviewEvidence => Boolean(e));
  if (!used.length || used.length !== c.evidence.length || !used.every((e) => STANDS_ON[kind].includes(e.kind))) return null;
  const next = (c.new ?? "").trim();
  if (!next) return null;
  const old = c.old?.length ? c.old : null;
  const section = old === null;
  if (section) {
    // A new section: its own H2 and a short answer, after a heading the article has (or before the close).
    if (kind === "product_fact" || kind === "newer_figure") return null;
    if (!/^##\s+\S/.test(next) || next.split("\n").filter((l) => /^#{1,2}\s/.test(l)).length !== 1) return null;
    const n = words(next.replace(/^##.*$/m, ""));
    if (n < PROPOSE.SECTION_MIN_WORDS || n > PROPOSE.SECTION_MAX_WORDS) return null;
    if (c.after && !body.split("\n").some((l) => l.replace(/^##\s+/, "").trim() === c.after!.trim() && /^##\s/.test(l))) return null;
  } else {
    if (occurrences(body, old) !== 1 || isHeadingOrDate(old) || old.includes("\n\n")) return null;
    // About as long as what it replaces: a sentence, not a rewrite.
    if (words(next) > Math.max(words(old) * 2, words(old) + 40)) return null;
  }
  // House style: nothing it adds breaks it.
  const before = old ?? "";
  if (dashesIn(next).length > dashesIn(before).length) return null;
  const tellsBefore = new Set(aiTellsIn(before));
  if (aiTellsIn(next).some((t) => !tellsBefore.has(t))) return null;
  // Every figure it states is in what it replaces or in its evidence.
  const known = figureSet([before, ...used.map((e) => `${e.text} ${e.detail}`)].join(" "));
  if (articleFigures(next).some((f) => !known.has(f.core))) return null;
  // Every link goes to a page its evidence names, or one it already had.
  const allowed = new Set([...used.map((e) => e.url).filter(Boolean), ...inlineLinks(before).map((l) => l.href)]);
  if (inlineLinks(next).some((l) => !allowed.has(l.href))) return null;
  const fingerprint = fingerprintOf(kind, used);
  if (dismissed.has(fingerprint)) return null;
  const cited = used.find((e) => e.kind === "new_fact" && e.url && inlineLinks(next).some((l) => l.href === e.url));
  return {
    id,
    kind,
    old,
    new: next,
    after: section ? (c.after?.trim() || null) : null,
    evidenceIds: used.map((e) => e.id),
    why: (c.why ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    real: isRealChange(old, next),
    ticked: kind !== "note",
    fingerprint,
    source: cited ? sourceOf(cited) : null,
  };
}

/** Changes to links alone, from code: a dead link loses its link and keeps its words; a moved one points to where it went. */
export function linkProposals(body: string, evidence: ReviewEvidence[], dismissed: Set<string>, startAt: number): ReviewProposal[] {
  const out: ReviewProposal[] = [];
  for (const e of evidence) {
    if (!e.url || (e.kind !== "dead_link" && e.kind !== "source_moved")) continue;
    const link = inlineLinks(body).find((l) => l.href === e.url);
    if (!link) continue;
    const md = `[${link.text}](${link.href})`;
    if (occurrences(body, md) !== 1) continue;
    const kind: ProposalKind = e.kind === "dead_link" ? "dead_source" : "source_link";
    const to = e.kind === "source_moved" ? e.detail.replace(/^Now at /, "").trim() : "";
    if (kind === "source_link" && !/^https:\/\//.test(to)) continue;
    const fingerprint = fingerprintOf(kind, [e]);
    if (dismissed.has(fingerprint)) continue;
    out.push({
      id: `p${startAt + out.length + 1}`,
      kind,
      old: md,
      new: kind === "dead_source" ? link.text : `[${link.text}](${to})`,
      after: null,
      evidenceIds: [e.id],
      why: kind === "dead_source" ? "The page it links to is gone" : "The page moved",
      real: false,
      ticked: true,
      fingerprint,
      source: null,
    });
  }
  return out;
}

const evidenceBlock = (evidence: ReviewEvidence[]) =>
  evidence
    .filter((e) => e.kind !== "dead_link" && e.kind !== "source_moved")
    .map((e) => `${e.id} [${e.kind}] ${e.text}${e.url ? ` (URL: ${e.url})` : ""}${e.year ? ` (year: ${e.year})` : ""}${e.detail ? ` (${e.detail})` : ""}`)
    .join("\n");

/** Read the model's changes; anything that isn't a list of changes is none. */
export function readCandidates(raw: string | null): Candidate[] {
  if (!raw) return [];
  try {
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { changes?: unknown };
    if (!Array.isArray(json.changes)) return [];
    return json.changes.slice(0, PROPOSE.MAX * 2).flatMap((x): Candidate[] => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      if (typeof o.kind !== "string" || typeof o.new !== "string") return [];
      return [
        {
          kind: o.kind,
          old: typeof o.old === "string" ? o.old : null,
          new: o.new,
          after: typeof o.after === "string" ? o.after : null,
          evidence: Array.isArray(o.evidence) ? o.evidence.filter((e): e is string => typeof e === "string") : [],
          why: typeof o.why === "string" ? o.why : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * The review's last step: code's link changes, then the model's, checked, within the growth cap.
 * Finding nothing worth changing counts as a check: the clock starts again and Updated stays.
 */
export const proposeStep: StepFn = async (ctx, { review, plan, node, usage, deadlineMs }, deps) => {
  const body = node.body;
  const dismissed = new Set(review.dismissed);
  const proposals = linkProposals(body, review.evidence, dismissed, 0);
  const forModel = review.evidence.filter((e) => e.kind !== "dead_link" && e.kind !== "source_moved");
  if (forModel.length) {
    const generate = deps.generate ?? generateTextWithDeadline;
    const prompt = renderPrompt("content.blog_refresh_propose", {
      brand_name: (plan.blog?.publisherName || plan.name).slice(0, 120),
      today: new Date().toISOString().slice(0, 10),
      max: PROPOSE.MAX - proposals.length,
      evidence: evidenceBlock(forModel),
      article: body,
    });
    const timeoutMs = Math.max(10_000, Math.min(PROPOSE.TIMEOUT_MS, deadlineMs - Date.now() - 3_000));
    const raw = await generate(await inBrandLanguage(prompt, usage), { timeoutMs, json: true, temperature: 0.2, thinkingBudget: PROPOSE.THINKING_BUDGET, usage });
    if (raw === null) return { error: "propose_failed" } satisfies StepResult;
    const byId = new Map(review.evidence.map((e) => [e.id, e] as const));
    const cap = Math.min(PROPOSE.MAX_WORDS, Math.round(words(body) * PROPOSE.GROWTH));
    let grown = 0;
    for (const c of readCandidates(raw)) {
      if (proposals.length >= PROPOSE.MAX) break;
      const p = checkProposal(body, c, byId, dismissed, `p${proposals.length + 1}`);
      if (!p || proposals.some((x) => x.fingerprint === p.fingerprint || (p.old && x.old === p.old))) continue;
      const adds = Math.max(0, words(p.new) - words(p.old ?? ""));
      if (grown + adds > cap) continue;
      grown += adds;
      proposals.push(p);
    }
  }
  if (!proposals.length) await checkedByReview(ctx, review, deps);
  return { proposals, finish: proposals.length ? "ready" : "nothing" } satisfies StepResult;
};

// ---- Apply and dismiss -----------------------------------------------------------------------

/** Insert a new section after the named H2's section, else before the closing sections, else at the end. */
export function insertSection(body: string, section: string, after: string | null): string {
  const lines = body.split("\n");
  let at = -1;
  if (after) {
    const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim() === after.trim());
    if (start >= 0) {
      const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
      at = next >= 0 ? next : lines.length;
    }
  }
  if (at < 0) {
    const closing = lines.findIndex((l) => CLOSING.test(l));
    at = closing >= 0 ? closing : lines.length;
  }
  const head = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const tail = lines.slice(at).join("\n").replace(/^\s+/, "");
  return `${head}\n\n${section.trim()}\n${tail ? `\n${tail}` : ""}`;
}

/** The copy with these changes made, and the ones that no longer fit it (the copy changed since). */
export function applyChanges(body: string, proposals: ReviewProposal[]): { body: string; applied: ReviewProposal[]; skipped: ReviewProposal[] } {
  let out = body;
  const applied: ReviewProposal[] = [];
  const skipped: ReviewProposal[] = [];
  for (const p of proposals) {
    if (p.old === null) {
      out = insertSection(out, p.new, p.after);
      applied.push(p);
    } else if (occurrences(out, p.old) === 1) {
      out = out.replace(p.old, () => p.new);
      applied.push(p);
    } else {
      skipped.push(p);
    }
  }
  return { body: out, applied, skipped };
}

export interface ApplyDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** The fact check (tests stub it). */
  factCheck?: typeof checkPlanBlogFacts;
}

export type ApplyResult =
  | { ok: true; node: ContentNode; applied: number; skipped: number; real: boolean; checked: boolean; review: ArticleReviewDoc | null; brief: BlogBrief | null }
  | { ok: false; status: number; error: string };

/** The brief's sources with the ones applied changes cite added, and the links taken out dropped. */
function sourcesAfter(current: BlogSource[], applied: ReviewProposal[], evidence: ReviewEvidence[]): BlogSource[] {
  const gone = new Set(applied.filter((p) => p.kind === "dead_source").flatMap((p) => p.evidenceIds.map((id) => evidence.find((e) => e.id === id)?.url ?? "")));
  const kept = current.filter((s) => !gone.has(s.url));
  for (const p of applied) {
    if (!p.source || kept.some((s) => s.url === p.source!.url)) continue;
    const s = BlogSourceSchema.safeParse({ ...p.source, status: "verified", origin: "web" });
    if (s.success) kept.unshift(s.data);
  }
  return kept.slice(0, 12);
}

/**
 * Apply the ticked changes. The copy it replaces is kept as a version first; the rest of the
 * proposals are dismissed. A real change moves Updated to now and starts the clock from it; link
 * fixes alone count as a check. The article goes back to "generated" for a person to approve.
 */
export async function applyReview(
  ctx: TenantContext,
  args: { workspace: { id: string; name: string; audience?: string | null }; planId: string; ids: string[] },
  deps: ApplyDeps = {},
): Promise<ApplyResult> {
  if (!isBlogRefreshEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const review = await readReview(ctx, args.planId, deps);
  if (!review || review.workspaceId !== args.workspace.id) return { ok: false, status: 404, error: "not_found" };
  if (review.state !== "ready") return { ok: false, status: 409, error: "not_ready" };
  const chosen = review.proposals.filter((p) => args.ids.includes(p.id));
  if (!chosen.length || chosen.length !== new Set(args.ids).size) return { ok: false, status: 400, error: "invalid_input" };
  const plan = await getContentPlan(ctx, review.workspaceId, review.planId, deps.db);
  const node = plan?.graph.nodes.find((n) => n.id === review.nodeId);
  if (!plan || !node) return { ok: false, status: 404, error: "not_found" };
  if (node.distributionStatus || node.scheduledAt) return { ok: false, status: 409, error: "locked" };

  const { body, applied, skipped } = applyChanges(node.body, chosen);
  if (!applied.length) return { ok: false, status: 409, error: "nothing_fits" };
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const real = applied.some((p) => p.real);

  await saveVersion(ctx, { plan, node, reason: "apply" }, deps);
  // The brief keeps the sources the changes cite (so the fact check keeps their links); the canvas takes it back.
  // The question the review was started for (Next up's Add to that article), once a change for it is
  // applied, joins the brief's questions with its map id: the brand map counts it as answered here.
  const asked = review.why.question ?? null;
  const askedUsed =
    asked && applied.some((p) => p.evidenceIds.some((id) => review.evidence.find((e) => e.id === id && e.kind === "open_question" && e.text === asked.text)));
  const questions =
    plan.blog && asked && askedUsed && !plan.blog.questions.some((q) => q.ref === asked.id) && plan.blog.questions.length < 10
      ? [...plan.blog.questions, { question: asked.text, intent: "other" as const, by: "operator" as const, ref: asked.id }]
      : null;
  const brief = plan.blog ? { ...plan.blog, sources: sourcesAfter(plan.blog.sources, applied, review.evidence), ...(questions ? { questions } : {}) } : null;
  if (brief) await updateContentPlan(ctx, plan.workspaceId, plan.id, { blog: brief }, deps.db);
  const updated = await updateContentPlanNode(ctx, plan.workspaceId, plan.id, node.id, { body, status: "generated" }, deps.db, {
    ...(real ? { setDates: (stored) => (stored?.published ? { ...stored, updated: { at, source: "change" as const } } : stored) } : {}),
    setFreshness: (stored, current) => (stored ? freshnessAfter(stored, current, at, real, now) : stored),
  });
  if (!updated) return { ok: false, status: 404, error: "not_found" };
  await leaveDueList(ctx, plan.id, at, deps);
  // The applied copy is the review's: it is the article's new AI original (the fact check below moves it on).
  await pinOriginal(
    ctx,
    { plan, node: updated, body: updated.body, made: { purpose: "blog_refresh", promptId: "content.blog_refresh_propose", sources: ["review"] } },
    { db: deps.db },
  ).catch(() => null);

  // The rest are dismissed: none of them comes back on this article.
  const left = review.proposals.filter((p) => !applied.includes(p)).map((p) => p.fingerprint);
  const after = await forTenant(ctx, deps.db)
    .articleReviews.claim(reviewId(plan.id), (cur) =>
      cur.reviewId === review.reviewId && cur.state === "ready" ? { state: "applied", dismissed: [...new Set([...cur.dismissed, ...left])].slice(-50), updatedAt: at } : null,
    )
    .catch(() => null);

  // The fact check reads the saved copy: the new sources keep their links through it.
  const fresh = await getContentPlan(ctx, plan.workspaceId, plan.id, deps.db);
  const checked = fresh ? await (deps.factCheck ?? checkPlanBlogFacts)(ctx, { workspace: args.workspace, plan: fresh, nodeId: node.id }).catch(() => null) : null;
  const finalNode = checked && checked.ok ? checked.node : updated;
  // The fact check syncs the brand map row; when it didn't run, the new question still has to count there.
  if (questions && !(checked && checked.ok)) await syncPlanPageSoftly(ctx, { workspaceId: plan.workspaceId, planId: plan.id }, { db: deps.db });
  await recordDecision(ctx, review, { outcome: "applied", accepted: applied.length, real, byUid: ctx.userId ?? null }, deps);
  return { ok: true, node: finalNode, applied: applied.length, skipped: skipped.length, real, checked: Boolean(checked?.ok), review: after, brief };
}

/** The article's freshness after Apply: a real change starts the clock from now as an update; links alone, as a check. */
function freshnessAfter(stored: BlogArticleFreshness, current: ContentNode, at: string, real: boolean, now: Date): BlogArticleFreshness {
  const dates = current.blog?.dates;
  const state = articleFreshness(
    { publishedAt: dates?.published?.at ?? null, updatedAt: real ? at : (dates?.updated?.at ?? null), checkedAt: real ? stored.checkedAt : at, clockDays: stored.clockDays, signals: [] },
    now,
  );
  return {
    ...stored,
    ...(real ? {} : { checkedAt: at }),
    openAtStart: null,
    ...(state ? { state: state.state, reasons: state.reasons, dueAt: state.dueAt } : {}),
    events: nextEvents(stored.events, { at, kind: real ? "updated" : "checked", clockDays: stored.clockDays }),
  };
}

/**
 * Dismiss every proposal: none of them comes back, and the article counts as checked (a person
 * looked and changed nothing), so its clock starts again and Updated stays.
 */
export async function dismissReview(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string },
  deps: ApplyDeps = {},
): Promise<{ ok: true; review: ArticleReviewDoc; node: ContentNode | null } | { ok: false; status: number; error: string }> {
  if (!isBlogRefreshEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const review = await forTenant(ctx, deps.db)
    .articleReviews.claim(reviewId(args.planId), (cur) =>
      cur.workspaceId === args.workspaceId && cur.state === "ready"
        ? { state: "dismissed", dismissed: [...new Set([...cur.dismissed, ...cur.proposals.map((p) => p.fingerprint)])].slice(-50), updatedAt: at }
        : null,
    )
    .catch(() => null);
  if (!review) return { ok: false, status: 409, error: "not_ready" };
  const checked = await markChecked(ctx, { workspaceId: args.workspaceId, planId: args.planId, nodeId: review.nodeId }, deps).catch(() => null);
  await recordDecision(ctx, review, { outcome: "dismissed", accepted: 0, real: false, byUid: ctx.userId ?? null }, deps);
  return { ok: true, review, node: checked?.ok ? checked.node : null };
}

/** A review that found nothing worth changing counts as a check: the clock starts again, Updated stays. */
export async function checkedByReview(ctx: TenantContext, review: ArticleReviewDoc, deps: ApplyDeps = {}): Promise<void> {
  await markChecked(ctx, { workspaceId: review.workspaceId, planId: review.planId, nodeId: review.nodeId }, deps).catch(() => null);
}
