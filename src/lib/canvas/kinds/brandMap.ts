import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { BrandMapChangeSchema, type BrandMapChange } from "@/lib/types/brandMap";
import { BRAND_KIT_MAP_ROUTE } from "@/lib/content/brandKit";
import { describeChange } from "@/lib/brandMap/changes";
import { isBrandMapChatEnabled, isBrandMapResearchEnabled } from "@/lib/brandMap/flags";
import { fileBrandMapSuggestions, readBrandMap } from "@/lib/brandMap/store";
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
 */

/** What Vizzy may suggest: everything but a link. */
const VIZZY_TYPES = ["set_identity", "add_is_not", "add_avoid", "add_subject", "add_question", "add_name", "add_alias"] as const;
const NO_LINKS = "Links (profile links, home pages, the site) are added by a person on Brand › Brand map, never from chat.";
const LINK = /\bhttps?:\/\/|\bwww\./i;

const BrandMapInput = z.object({
  mode: z.enum(["add", "research"]),
  changes: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
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

function outcome(args: { filed: number; waiting: number; summary: string; warnings: string[] }): CanvasAuthorOutcome {
  const url = BRAND_KIT_MAP_ROUTE;
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
  deps: { db?: FirestoreLike; research?: ResearchDeps; nowMs?: number } = {},
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
    return outcome({
      filed: r.filed,
      waiting: r.map?.suggestions.length ?? r.filed,
      summary: r.filed
        ? `Research filed ${plural(r.filed, "suggestion")} for your brand map (${r.summary}). ${UNCHANGED}`
        : `Research found nothing new for your brand map. ${UNCHANGED.replace("them", "what waits")}`,
      warnings: r.notes,
    });
  }

  const parsed = parseChanges(req.data.changes);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, issues: parsed.issues };
  if (!parsed.changes.length) return { ok: false, status: 400, error: "invalid_input", issues: ["changes: at least one change to suggest"] };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };

  const reason = brief.replace(/\s+/g, " ").trim().slice(0, 200) || "Suggested in chat";
  const filed = await fileBrandMapSuggestions(
    ctx,
    { from: "vizzy", items: parsed.changes.map((change) => ({ change, reason, evidence: "asked" as const })) },
    { db: deps.db, nowMs: deps.nowMs },
  );
  if (!filed.ok) return { ok: false, status: filed.status, error: filed.error };
  const after = await readBrandMap(ctx, deps.db).catch(() => null);
  const said = filed.value.filed.map((s) => describeChange(s.change));
  const { inMap, waiting, dismissed } = filed.value.skipped;
  const skipped = [
    inMap ? `${plural(inMap, "was", "were")} already on the map` : "",
    waiting ? `${plural(waiting, "was", "were")} already waiting` : "",
    dismissed ? `${plural(dismissed, "was", "were")} dismissed before` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return outcome({
    filed: said.length,
    waiting: after?.state === "ok" ? after.map.suggestions.length : said.length,
    summary:
      (said.length
        ? `Filed ${plural(said.length, "suggestion")} for your brand map: ${said.slice(0, 5).join("; ")}${said.length > 5 ? `; and ${said.length - 5} more` : ""}.`
        : "Filed no suggestions for your brand map.") +
      (skipped ? ` Of what you asked, ${skipped}.` : "") +
      ` ${UNCHANGED}`,
    warnings: [],
  });
}

export const brandMapCanvasKind: CanvasKind = {
  kind: "brand_map",
  label: "brand map suggestions",
  authorDraft: (args) => authorBrandMapSuggestions(args),
};
