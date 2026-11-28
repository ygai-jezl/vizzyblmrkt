import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import type { AdminGate } from "@/lib/connect/admin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { meaningsOf } from "@/lib/metrics/meanings";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isRateLimited } from "@/lib/tenant";
import type { RateLimitConfig } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { deckChecks, type Check } from "./checks";
import { draftDeck, type DraftDeps } from "./draft";
import { isRaiseKitEnabled, isVizzyRaiseEnabled } from "./flags";
import { fillBlock, metricReader, numberOptions, refreshBlocks, sameRequest, sameTyped, typedBlock, type MetricDeps, type MetricReader, type NumberOptions } from "./metrics";
import { kindLabel } from "./outlines";
import { countRaiseDocs, deckTotals, deleteRaiseDoc, exportRaiseDoc, listRaiseDocs, readRaiseDoc, restoreRaiseVersion, saveRaiseVersion, type RaiseResult, type StoreDeps } from "./store";
import { keepTokens, talkSeconds, wordsOf } from "./text";
import { loadDeckTheme, type DeckTheme, type ThemeDeps } from "./theme";
import {
  BLOCK_ID,
  BLOCK_UNITS,
  CURRENCIES,
  CompareSchema,
  LAYOUT_KEYS,
  NEED_ID,
  RAISE_DOC_LIMITS as L,
  SECTION_KEYS,
  SERVER_MEANINGS,
  SLIDE_ID,
  SlidePersonSchema,
  newId,
  type DeckAudience,
  type DeckStage,
  type MetricBlock,
  type PackLine,
  type RaiseDoc,
  type Slide,
} from "./types";
import { NOTE_WORDS } from "./words";

/**
 * The Raise kit's admin APIs (Content › Raise kit): origin, switch, sign-in and role, in that order,
 * as the brand map's. Members open, present and save any deck as a PDF; admins make, change,
 * restore, refresh, download and delete. New deck, and every model call, also asks brandCanUse
 * (raise_kit); everything else works without it, so a brand that loses the feature keeps its
 * decks. The tenant always comes from the session, and a deck id is looked up through it, so
 * another brand's id is simply not found.
 */

export const DRAFT_LIMIT: RateLimitConfig = { prefix: "raise_draft", burstLimit: 2, hourlyLimit: 8 };
export const REVISE_LIMIT: RateLimitConfig = { prefix: "raise_revise", burstLimit: 6, hourlyLimit: 40 };
export const NUMBERS_LIMIT: RateLimitConfig = { prefix: "raise_numbers", burstLimit: 4, hourlyLimit: 30 };
export const SAVE_LIMIT: RateLimitConfig = { prefix: "raise_save", burstLimit: 20, hourlyLimit: 300 };
export const AGENT_LIMIT: RateLimitConfig = { prefix: "raise_agent", burstLimit: 10, hourlyLimit: 120 };

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

async function gate(req: Request, admin: boolean): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isRaiseKitEnabled()) return { ok: false, response: json({ error: "raise_kit_disabled" }, 503) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  if (admin && ctx.role !== "admin") return { ok: false, response: json({ error: "forbidden" }, 403) };
  return { ok: true, ctx };
}

/** Reading decks: any signed-in member of the brand. */
export const raiseReader = (req: Request) => gate(req, false);
/** Changing decks: admins only. */
export const raiseAdmin = (req: Request) => gate(req, true);

export interface ApiDeps extends StoreDeps {
  metrics?: MetricDeps;
  theme?: ThemeDeps;
  draft?: Omit<DraftDeps, keyof StoreDeps>;
  /** brandCanUse(ctx, "raise_kit"), for tests. */
  granted?: (ctx: TenantContext) => Promise<boolean>;
  /** isRateLimited, for tests. */
  limited?: (ctx: TenantContext, limit: RateLimitConfig) => Promise<boolean>;
}

export const canUseRaiseKit = (ctx: TenantContext, deps: Pick<ApiDeps, "granted"> = {}) => (deps.granted ?? ((c) => brandCanUse(c, "raise_kit")))(ctx);
export const overLimit = (ctx: TenantContext, limit: RateLimitConfig, deps: Pick<ApiDeps, "limited" | "db"> = {}) =>
  (deps.limited ?? ((c, l) => isRateLimited(`tenant:${c.tenantId}`, l, { db: deps.db })))(ctx, limit);

function failed(r: Extract<RaiseResult<unknown>, { ok: false }>): Response {
  return json({ error: r.error, ...(r.version !== undefined ? { version: r.version } : {}) }, r.status);
}

const invalid = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) =>
  json({ error: "invalid_input", issues: issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) }, 400);

// ----- The view --------------------------------------------------------------------------------

export interface DeckView {
  id: string;
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  kindLabel: string;
  status: "draft";
  version: number;
  updatedAt: string;
  slides: Slide[];
  checks: Check[];
  talk: { words: number; talkSeconds: number; perSlide: Array<{ slideId: string; words: number; talkSeconds: number }> };
  /** How many slides still have Needs. */
  needs: number;
  /** Every version ever, newest first; `kept` ones can be viewed and put back. */
  versions: Array<{ n: number; note: string; by: "Vizzy" | "You" | "A teammate"; at: string; kept: boolean }>;
  sources: PackLine[];
  numberOptions: NumberOptions;
  theme: DeckTheme;
  canEdit: boolean;
  /** Ask Vizzy to change a slide: an admin, Vizzy's switch, and the brand's plan. */
  canDraft: boolean;
  meanings: ReturnType<typeof meaningsOf>;
}

export function byLabel(by: string, ctx: Pick<TenantContext, "userId">): "Vizzy" | "You" | "A teammate" {
  if (by === "vizzy") return "Vizzy";
  return ctx.userId && by === ctx.userId ? "You" : "A teammate";
}

/** The deck as its page and Vizzy's card show it: checks, talk time, versions, numbers it can insert and the look. */
export async function deckView(ctx: TenantContext, doc: RaiseDoc, deps: ApiDeps = {}, reader?: MetricReader): Promise<DeckView> {
  const r = reader ?? metricReader(ctx, { db: deps.db, ...deps.metrics });
  const [options, theme, granted] = await Promise.all([numberOptions(r), loadDeckTheme(ctx, deps.theme), canUseRaiseKit(ctx, deps).catch(() => false)]);
  const slides = doc.current.slides;
  const kept = new Set(doc.versions.map((v) => v.n));
  const canEdit = ctx.role === "admin";
  const totals = deckTotals(slides);
  return {
    id: doc.id,
    title: doc.title,
    audience: doc.audience,
    stage: doc.stage,
    kindLabel: kindLabel(doc.audience, doc.stage),
    status: "draft",
    version: doc.version,
    updatedAt: doc.updatedAt,
    slides,
    checks: deckChecks({ audience: doc.audience, slides }),
    talk: { words: totals.words, talkSeconds: totals.talkSeconds, perSlide: slides.map((s) => ({ slideId: s.id, words: wordsOf(s), talkSeconds: talkSeconds(wordsOf(s)) })) },
    needs: slides.filter((s) => s.needs.length > 0).length,
    versions: doc.changes.map((c) => ({ n: c.n, note: c.note, by: byLabel(c.by, ctx), at: c.at, kept: kept.has(c.n) })),
    sources: doc.sources,
    numberOptions: options,
    theme,
    canEdit,
    canDraft: canEdit && granted && isVizzyRaiseEnabled(),
    meanings: meaningsOf([...new Set(slides.flatMap((s) => s.blocks.map((b) => b.meaning))), "talkSeconds"]),
  };
}

// ----- List and New deck -----------------------------------------------------------------------

export async function listFromRequest(ctx: TenantContext, deps: ApiDeps = {}): Promise<Response> {
  const [docs, granted] = await Promise.all([listRaiseDocs(ctx, deps), canUseRaiseKit(ctx, deps).catch(() => false)]);
  return json({ docs, granted, canMake: ctx.role === "admin" && granted && docs.length < L.decks, limit: L.decks });
}

const NewDeckBody = z.object({
  audience: z.enum(["investor", "lender"]),
  stage: z.enum(["pre_seed", "seed"]).optional(),
  title: z.string().trim().max(L.title).optional(),
  brief: z.string().trim().max(1500).optional(),
});

/** New deck: the plan, the draft limit, the 20 deck limit, then one draft. */
export async function createFromRequest(ctx: TenantContext, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = NewDeckBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (!(await canUseRaiseKit(ctx, deps))) return json({ error: "not_included" }, 403);
  if (await overLimit(ctx, DRAFT_LIMIT, deps)) return json({ error: "rate_limited" }, 429);
  if ((await countRaiseDocs(ctx, deps)) >= L.decks) return json({ error: "deck_limit" }, 409);
  const made = await draftDeck(ctx, { ...parsed.data, by: ctx.userId ?? "unknown" }, { db: deps.db, now: deps.now, metrics: deps.metrics, ...deps.draft });
  if (!made.ok) return failed(made);
  return json({ doc: await deckView(ctx, made.value.doc, deps), drafted: made.value.drafted, warnings: made.value.warnings }, 201);
}

// ----- One deck --------------------------------------------------------------------------------

export async function readFromRequest(ctx: TenantContext, docId: string, deps: ApiDeps = {}): Promise<Response> {
  const doc = await readRaiseDoc(ctx, docId, deps);
  if (!doc) return json({ error: "not_found" }, 404);
  return json({ doc: await deckView(ctx, doc, deps) });
}

const Text = (max: number) => z.string().max(max);
const ServerBlockInput = z.object({
  id: z.string().regex(BLOCK_ID).optional(),
  meaning: z.enum(SERVER_MEANINGS),
  grain: z.enum(["total", "week"]).default("total"),
  weeks: z.union([z.literal(4), z.literal(8), z.literal(12)]).optional(),
  launchId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
const TypedBlockInput = z.object({
  id: z.string().regex(BLOCK_ID).optional(),
  meaning: z.literal("typed"),
  grain: z.enum(["total", "week", "month"]).optional(),
  name: z.string().trim().min(1).max(L.typedName),
  value: z.number().finite().min(-L.maxValue).max(L.maxValue),
  unit: z.enum(BLOCK_UNITS),
  currency: z.enum(CURRENCIES).optional(),
  per: z.enum(["month", "year"]).nullable().optional(),
  series: z.array(z.object({ label: z.string().trim().max(24), value: z.number().finite().min(-L.maxValue).max(L.maxValue) })).max(L.series).optional(),
  from: z.string().trim().max(L.typedFrom).optional(),
});
const SlideInput = z.object({
  id: z.string().regex(SLIDE_ID).optional(),
  section: z.enum(SECTION_KEYS),
  layout: z.enum(LAYOUT_KEYS),
  headline: Text(L.headline),
  points: z.array(Text(L.point)).max(L.points),
  compare: CompareSchema.optional(),
  people: z.array(SlidePersonSchema).max(L.people).optional(),
  blocks: z.array(z.union([ServerBlockInput, TypedBlockInput])).max(L.blocks),
  notes: Text(L.notes),
  needs: z.array(z.object({ id: z.string().regex(NEED_ID).optional(), text: z.string().trim().min(1).max(L.need) })).max(L.needs).default([]),
  sources: z.array(z.string().max(8)).max(L.sources).default([]),
});
type SlideInput = z.infer<typeof SlideInput>;
const SaveBody = z.object({
  baseVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(L.title).optional(),
  slides: z.array(SlideInput).min(L.minSlides).max(L.slides),
  note: z.string().trim().max(L.note).optional(),
});

/**
 * A person's slides as stored slides. A server block they sent is kept frozen when it is the one
 * already stored, and filled now when it is new; a typed block keeps its stamps unless it changed,
 * then it is stamped with who typed it and when. Vizzy's originals are never taken from the client.
 */
export async function slidesFromInput(ctx: TenantContext, doc: RaiseDoc, input: SlideInput[], reader: MetricReader): Promise<Slide[]> {
  const stored = new Map<string, MetricBlock>(doc.current.slides.flatMap((s) => s.blocks.map((b) => [b.id, b] as const)));
  const sourceIds = new Set(doc.sources.map((s) => s.id));
  const slideIds = new Set<string>();
  const blockIds = new Set<string>();
  const fresh = (id: string | undefined, used: Set<string>, prefix: "sl" | "mb") => {
    const out = id && !used.has(id) ? id : newId(prefix);
    used.add(out);
    return out;
  };
  const out: Slide[] = [];
  for (const s of input) {
    const blocks: MetricBlock[] = [];
    for (const b of s.blocks) {
      const old = b.id && !blockIds.has(b.id) ? stored.get(b.id) : undefined;
      if (b.meaning === "typed") {
        const typed = { ...b, grain: b.grain === "total" ? undefined : b.grain };
        if (old && sameTyped(old, typed)) {
          blockIds.add(old.id);
          blocks.push(old);
        } else {
          blocks.push(typedBlock({ ...typed, id: fresh(b.id, blockIds, "mb") }, { typedBy: ctx.userId ?? "unknown" }, reader.now));
        }
        continue;
      }
      const req = { ...b, grain: b.grain };
      if (old && sameRequest(old, req)) {
        blockIds.add(old.id);
        blocks.push(old);
      } else {
        blocks.push((await fillBlock(reader, { ...req, id: fresh(b.id, blockIds, "mb") })).block);
      }
    }
    const ids = new Set(blocks.map((b) => b.id));
    const t = (text: string) => keepTokens(text, ids);
    out.push({
      id: fresh(s.id, slideIds, "sl"),
      section: s.section,
      layout: s.layout,
      headline: t(s.headline),
      points: s.points.map(t),
      ...(s.compare ? { compare: { ...s.compare, rows: s.compare.rows.map((r) => ({ left: t(r.left), right: t(r.right) })) } } : {}),
      ...(s.people ? { people: s.people } : {}),
      blocks,
      notes: t(s.notes),
      needs: s.needs.map((n) => ({ id: n.id ?? newId("nd"), text: n.text })),
      sources: s.sources.filter((id) => sourceIds.has(id)),
    });
  }
  return out;
}

/** Save a person's change as a new version (with their note, or one worked out from the change). */
export async function saveFromRequest(ctx: TenantContext, docId: string, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = SaveBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (await overLimit(ctx, SAVE_LIMIT, deps)) return json({ error: "rate_limited" }, 429);
  const doc = await readRaiseDoc(ctx, docId, deps);
  if (!doc) return json({ error: "not_found" }, 404);
  if (doc.version !== parsed.data.baseVersion) return json({ error: "stale_version", version: doc.version }, 409);
  const reader = metricReader(ctx, { db: deps.db, ...deps.metrics });
  const slides = await slidesFromInput(ctx, doc, parsed.data.slides, reader);
  const saved = await saveRaiseVersion(ctx, doc.id, { baseVersion: parsed.data.baseVersion, title: parsed.data.title, slides, note: parsed.data.note, by: ctx.userId ?? "unknown" }, deps);
  if (!saved.ok) return failed(saved);
  return json({ doc: await deckView(ctx, saved.value.doc, deps, reader), saved: saved.value.saved });
}

export async function deleteFromRequest(ctx: TenantContext, docId: string, deps: ApiDeps = {}): Promise<Response> {
  if (await overLimit(ctx, SAVE_LIMIT, deps)) return json({ error: "rate_limited" }, 429);
  if (!(await deleteRaiseDoc(ctx, docId, deps))) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

const BaseBody = z.object({ baseVersion: z.number().int().min(1) });

/** Refresh numbers: every server block filled again; a new version only when a figure moved. */
export async function refreshFromRequest(ctx: TenantContext, docId: string, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = BaseBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (await overLimit(ctx, NUMBERS_LIMIT, deps)) return json({ error: "rate_limited" }, 429);
  const doc = await readRaiseDoc(ctx, docId, deps);
  if (!doc) return json({ error: "not_found" }, 404);
  if (doc.version !== parsed.data.baseVersion) return json({ error: "stale_version", version: doc.version }, 409);
  const reader = metricReader(ctx, { db: deps.db, ...deps.metrics });
  const { slides, changed } = await refreshBlocks(reader, doc.current.slides);
  if (!changed.length) return json({ doc: await deckView(ctx, doc, deps, reader), changed: [] });
  const note = NOTE_WORDS.refreshed(changed.map((c) => `slide ${c.slideN} ${c.name} ${c.from} to ${c.to}`));
  const saved = await saveRaiseVersion(ctx, doc.id, { baseVersion: doc.version, slides, note, by: ctx.userId ?? "unknown" }, deps);
  if (!saved.ok) return failed(saved);
  return json({ doc: await deckView(ctx, saved.value.doc, deps, reader), changed });
}

const versionNumber = (raw: string) => (/^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null);

/** One kept version, with its checks, to view. */
export async function versionFromRequest(ctx: TenantContext, docId: string, rawN: string, deps: ApiDeps = {}): Promise<Response> {
  const n = versionNumber(rawN);
  const doc = await readRaiseDoc(ctx, docId, deps);
  if (!doc) return json({ error: "not_found" }, 404);
  const v = n === null ? undefined : doc.versions.find((x) => x.n === n);
  if (!v) return json({ error: "version_not_kept" }, 404);
  return json({ version: { n: v.n, note: v.note, by: byLabel(v.by, ctx), at: v.at, title: v.title, slides: v.slides, checks: deckChecks({ audience: doc.audience, slides: v.slides }) } });
}

/** Put a kept version back, as a new version. */
export async function restoreFromRequest(ctx: TenantContext, docId: string, rawN: string, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = BaseBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  const n = versionNumber(rawN);
  if (n === null) return json({ error: "version_not_kept" }, 404);
  if (await overLimit(ctx, SAVE_LIMIT, deps)) return json({ error: "rate_limited" }, 429);
  const saved = await restoreRaiseVersion(ctx, docId, { n, baseVersion: parsed.data.baseVersion, by: ctx.userId ?? "unknown" }, deps);
  if (!saved.ok) return failed(saved);
  return json({ doc: await deckView(ctx, saved.value.doc, deps) });
}

/** Download data: the deck and its kept versions, as a file. */
export async function exportFromRequest(ctx: TenantContext, docId: string, deps: ApiDeps = {}): Promise<Response> {
  const data = await exportRaiseDoc(ctx, docId, deps);
  if (!data) return json({ error: "not_found" }, 404);
  return json(data, 200, { "content-disposition": `attachment; filename="raise-deck-${data.deck.id}.json"` });
}
