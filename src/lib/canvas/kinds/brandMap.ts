import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { BrandMapChangeSchema, type BrandMapChange } from "@/lib/types/brandMap";
import { BRAND_KIT_MAP_ROUTE } from "@/lib/content/brandKit";
import { describeChange } from "@/lib/brandMap/changes";
import { isBrandMapChatEnabled, isBrandMapResearchEnabled, isBrandMapScaleEnabled, isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { SituationSide, SituationW } from "@/lib/types/brandMapRecords";
import { findSituations, type FindDeps } from "@/lib/brandMap/findSituations";
import { askSituationQuestions, type AskDeps } from "@/lib/brandMap/situationQuestions";
import { parseSituation, proposeSituation } from "@/lib/brandMap/situations";
import { startRun, takeStep } from "@/lib/brandMap/runs";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { readBrandMap } from "@/lib/brandMap/store";
import { fileSuggestions } from "@/lib/brandMap/filing";
import { proposalsWaiting, suggestionsWaiting } from "@/lib/brandMap/waiting";
import { RESEARCH_LIMIT, runBrandMapResearch, type ResearchDeps } from "@/lib/brandMap/adminApi";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `brand_map` canvas kind (BRAND_MAP_CHAT_ENABLED): Vizzy suggests changes to the brand
 * map from chat. It only ever files suggestions: nothing decided changes until an admin
 * accepts one on Brand › Brand map, so it is admins only, as saving is. Brand-wide (the tenant
 * comes from the signed token).
 *  - `add`: the changes the agent sends, as suggestions from Vizzy. Never a link: profile
 *    links, home pages and the site are a person's to add on the page, and any text holding
 *    an address is refused.
 *  - `research`: research the map, as the page's "Research again" does (its own switch).
 * With buying situations on (and the map at any size), `add` can also propose situations, and
 * link the questions it proposes to one; `situations` finds the situations people are in, and
 * `situation_questions` what people in one ask — each a proposal, each one research allowance.
 */

/** What Vizzy may suggest: everything but a link. */
const VIZZY_TYPES = ["set_identity", "add_is_not", "add_avoid", "add_subject", "add_question", "add_name", "add_alias"] as const;
const NO_LINKS = "Links (profile links, home pages, the site) are added by a person on Brand › Brand map, never from chat.";
const LINK = /\bhttps?:\/\/|\bwww\./i;

const SituationIn = z.object({
  text: z.string().trim().min(1).max(200),
  w: SituationW.optional(),
  wText: z.string().max(120).optional(),
  who: z.string().max(120).optional(),
  side: SituationSide.optional(),
  want: z.string().max(120).optional(),
  feel: z.string().max(120).optional(),
});

const BrandMapInput = z.object({
  mode: z.enum(["add", "research", "situations", "situation_questions"]),
  changes: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  /** `add`: buying situations to propose. */
  situations: z.array(SituationIn).max(10).default([]),
  /** `add`: the situation the proposed questions are asked in; `situation_questions`: the one to research. */
  situationId: z.string().max(64).optional(),
  /** `situations`: what made the last few customers start looking, in the brand's words. */
  customers: z.string().max(300).optional(),
});

const AUTHOR_LIMIT = { prefix: "brand_map_author", burstLimit: 5, hourlyLimit: 30 };
const RESEARCH_MS = 55_000;
const NOTE = "Suggestions — nothing in the map changes until an admin accepts them.";
const UNCHANGED = "Nothing in the map has changed: an admin reviews them on Brand › Brand map.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The changes asked for, each checked as the store checks it; any link refused. */
function parseChanges(raw: Array<Record<string, unknown>>): { ok: true; changes: BrandMapChange[] } | { ok: false; error: string; issues: string[] } {
  const issues: string[] = [];
  const changes: BrandMapChange[] = [];
  raw.forEach((c, i) => {
    const strings = Object.values(c).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));
    if (
      !VIZZY_TYPES.includes(c.type as (typeof VIZZY_TYPES)[number]) ||
      (c.type === "set_identity" && c.field === "site") ||
      strings.some((s) => LINK.test(s))
    ) {
      issues.push(`changes.${i}: ${NO_LINKS}`);
      return;
    }
    const parsed = BrandMapChangeSchema.safeParse(c);
    if (!parsed.success) issues.push(...parsed.error.issues.map((x) => `changes.${i}.${x.path.join(".")}: ${x.message}`));
    else changes.push(parsed.data);
  });
  if (issues.length) return { ok: false, error: issues.some((x) => x.includes(NO_LINKS)) ? "links_not_allowed" : "invalid_input", issues };
  return { ok: true, changes };
}

function outcome(args: { filed: number; waiting: number; summary: string; warnings: string[] }, url: string = BRAND_KIT_MAP_ROUTE): CanvasAuthorOutcome {
  return {
    ok: true,
    id: "brand_map",
    status: "suggested",
    url,
    summary: args.summary,
    warnings: args.warnings,
    card: {
      kind: "brand_map",
      // The map's suggestions are one list: a newer card replaces this one.
      id: "brand_map",
      title: "Brand map suggestions",
      url,
      stats: [
        { label: "filed", value: args.filed },
        { label: "waiting", value: args.waiting },
      ],
      warnings: args.warnings.length,
      note: NOTE,
      cta: "Review and apply",
    },
  };
}

export async function authorBrandMapSuggestions(
  { ctx, input, brief }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike; research?: ResearchDeps; nowMs?: number; find?: Omit<FindDeps, "db" | "nowMs">; ask?: Omit<AskDeps, "db" | "nowMs"> } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isBrandMapChatEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Accepting a suggestion is an admin's, so suggesting is too. A token without a role fails closed.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  const req = BrandMapInput.safeParse(input);
  if (!req.success) return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };

  if (req.data.mode === "research") {
    if (!isBrandMapResearchEnabled()) return { ok: false, status: 503, error: "research_disabled" };
    if (await isRateLimited(`tenant:${ctx.tenantId}`, RESEARCH_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };
    const r = await runBrandMapResearch(ctx, { db: deps.db, nowMs: deps.nowMs, timeoutMs: RESEARCH_MS, ...deps.research });
    if (!r.ok) return r;
    const proposals = await proposalsWaiting(ctx, { db: deps.db });
    return outcome({
      filed: r.filed,
      waiting: (r.map ? suggestionsWaiting(r.map).length : r.filed) + proposals,
      summary: r.filed
        ? `Research filed ${plural(r.filed, "suggestion")} for your brand map (${r.summary}). ${UNCHANGED}`
        : `Research found nothing new for your brand map. ${UNCHANGED.replace("them", "what waits")}`,
      warnings: r.notes,
    });
  }

  const situationsOn = isBrandMapScaleEnabled() && isBrandMapSituationsEnabled();
  if (req.data.mode === "situations" || req.data.mode === "situation_questions") {
    if (!situationsOn) return { ok: false, status: 503, error: "situations_disabled" };
    if (!isBrandMapResearchEnabled()) return { ok: false, status: 503, error: "research_disabled" };
    return researchSituations(ctx, req.data, deps);
  }

  const parsed = parseChanges(req.data.changes);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, issues: parsed.issues };
  if (req.data.situations.length && !situationsOn) return { ok: false, status: 503, error: "situations_disabled" };
  if (req.data.situations.some((x) => Object.values(x).some((v) => typeof v === "string" && LINK.test(v)))) {
    return { ok: false, status: 400, error: "links_not_allowed", issues: [`situations: ${NO_LINKS}`] };
  }
  if (!parsed.changes.length && !req.data.situations.length) {
    return { ok: false, status: 400, error: "invalid_input", issues: ["changes: at least one change or buying situation to suggest"] };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };

  const reason = brief.replace(/\s+/g, " ").trim().slice(0, 200) || "Suggested in chat";
  // Questions are linked to a situation only when it is one the map has (decided or waiting).
  const linkTo =
    situationsOn && req.data.situationId ? parseSituation(await brandMapRecords(ctx, deps.db).get("sit", req.data.situationId).catch(() => null)) : null;
  const situationIds = linkTo && linkTo.status !== "dismissed" ? [linkTo.id] : undefined;
  const filed = parsed.changes.length
    ? await fileSuggestions(
        ctx,
        { from: "vizzy", items: parsed.changes.map((change) => ({ change, reason, evidence: "asked" as const })), ...(situationIds ? { situationIds } : {}) },
        { db: deps.db, nowMs: deps.nowMs },
      )
    : ({ ok: true, value: { filed: [], skipped: { inMap: 0, waiting: 0, dismissed: 0 }, proposed: [] } } as const);
  if (!filed.ok) return { ok: false, status: filed.status, error: filed.error };
  const proposedSituations: string[] = [];
  for (const sit of req.data.situations) {
    const made = await proposeSituation(ctx, sit, { from: "vizzy", reason, revive: true }, { db: deps.db, nowMs: deps.nowMs });
    if (made) proposedSituations.push(`Add a buying situation: “${made.text}”`);
  }
  const after = await readBrandMap(ctx, deps.db).catch(() => null);
  const said = [...filed.value.filed.map((s) => describeChange(s.change)), ...filed.value.proposed, ...proposedSituations];
  const { inMap, waiting, dismissed } = filed.value.skipped;
  const skipped = [
    inMap ? `${plural(inMap, "was", "were")} already on the map` : "",
    waiting ? `${plural(waiting, "was", "were")} already waiting` : "",
    dismissed ? `${plural(dismissed, "was", "were")} dismissed before` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const proposals = await proposalsWaiting(ctx, { db: deps.db });
  return outcome({
    filed: said.length,
    waiting: (after?.state === "ok" ? suggestionsWaiting(after.map).length : said.length) + proposals,
    summary:
      (said.length
        ? `Filed ${plural(said.length, "suggestion")} for your brand map: ${said.slice(0, 5).join("; ")}${said.length > 5 ? `; and ${said.length - 5} more` : ""}.`
        : "Filed no suggestions for your brand map.") +
      (skipped ? ` Of what you asked, ${skipped}.` : "") +
      ` ${UNCHANGED}`,
    warnings: [],
  });
}

/** Research for buying situations from chat: the situations people are in, or what people in one ask. Proposals only. */
async function researchSituations(
  ctx: CanvasAuthorArgs["ctx"],
  input: z.infer<typeof BrandMapInput>,
  deps: { db?: FirestoreLike; nowMs?: number; find?: Omit<FindDeps, "db" | "nowMs">; ask?: Omit<AskDeps, "db" | "nowMs"> },
): Promise<CanvasAuthorOutcome> {
  const url = `${BRAND_KIT_MAP_ROUTE}`;
  if (input.mode === "situations") {
    // One research allowance for the run, then its step.
    const run = await startRun(ctx, "situations", { db: deps.db, nowMs: deps.nowMs });
    if (!run.ok) return run;
    const step = await takeStep(ctx, run.value.id, "situations", { db: deps.db, nowMs: deps.nowMs }, { once: "find" });
    if (!step.ok) return step;
    const r = await findSituations(ctx, { customers: input.customers, timeoutMs: RESEARCH_MS }, { db: deps.db, nowMs: deps.nowMs, ...deps.find });
    if (!r.ok) return r;
    const unbacked = r.found.filter((s) => !s.backed).length;
    const proposals = await proposalsWaiting(ctx, { db: deps.db });
    return outcome({
      filed: r.found.length,
      waiting: proposals,
      summary: r.found.length
        ? `Research proposed ${plural(r.found.length, "buying situation")}${unbacked ? ` (${unbacked} not backed by your site or knowledge)` : ""}: ${r.found
            .slice(0, 5)
            .map((s) => `“${s.text}”`)
            .join("; ")}${r.found.length > 5 ? `; and ${r.found.length - 5} more` : ""}. Nothing on the map has changed: an admin adds the ones that fit on Brand › Brand map › Buying situations.`
        : `Research found no new buying situations${r.skipped ? ` (${plural(r.skipped, "was", "were")} already there or turned down)` : ""}. Nothing on the map has changed.`,
      warnings: r.notes,
    }, url);
  }
  if (!input.situationId) return { ok: false, status: 400, error: "invalid_input", issues: ["situationId: which buying situation to research"] };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, RESEARCH_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };
  const r = await askSituationQuestions(ctx, input.situationId, { db: deps.db, nowMs: deps.nowMs, timeoutMs: RESEARCH_MS, ...deps.ask });
  if (!r.ok) return r;
  const fresh = r.questions.filter((q) => !q.linked);
  const onNew = fresh.filter((q) => q.newSubject).length;
  const linked = r.questions.length - fresh.length;
  const proposals = await proposalsWaiting(ctx, { db: deps.db });
  return outcome({
    filed: fresh.length,
    waiting: proposals,
    summary:
      (fresh.length
        ? `Proposed ${plural(fresh.length, "question")} people in that situation ask${onNew ? ` (${onNew} on new subjects)` : ""}: ${fresh
            .slice(0, 5)
            .map((q) => `“${q.text}”`)
            .join("; ")}${fresh.length > 5 ? `; and ${fresh.length - 5} more` : ""}.`
        : "Found no new questions for that situation.") +
      (linked ? ` ${plural(linked, "question")} the map already had ${linked === 1 ? "is" : "are"} now linked to it.` : "") +
      " Nothing else on the map has changed: an admin adds the questions on Brand › Brand map.",
    warnings: [],
  }, url);
}

export const brandMapCanvasKind: CanvasKind = {
  kind: "brand_map",
  label: "brand map suggestions",
  authorDraft: (args) => authorBrandMapSuggestions(args),
};
