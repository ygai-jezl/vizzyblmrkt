import { z } from "zod";
import type { TenantContext } from "@/lib/tenant/types";
import type { RateLimitConfig } from "@/lib/tenant/rateLimit";
import { DRAFT_LIMIT, NUMBERS_LIMIT, REVISE_LIMIT, canUseRaiseKit, overLimit } from "@/lib/raise/docs/adminApi";
import { deckChecks } from "@/lib/raise/docs/checks";
import { clip, draftDeck, type DraftDeps } from "@/lib/raise/docs/draft";
import { isVizzyRaiseEnabled } from "@/lib/raise/docs/flags";
import { kindLabel } from "@/lib/raise/docs/outlines";
import { raiseDocHref } from "@/lib/raise/docs/paths";
import { onlyRefresh, parseOps, reviseDeck, type ReviseDeps } from "@/lib/raise/docs/revise";
import { countRaiseDocs, listRaiseDocs, readRaiseDoc, type StoreDeps } from "@/lib/raise/docs/store";
import { DECK_AUDIENCES, INVESTOR_STAGES, RAISE_DOC_ID, RAISE_DOC_LIMITS as L, type RaiseDoc } from "@/lib/raise/docs/types";
import { CARD_NOTE, CHAT_WORDS } from "@/lib/raise/docs/words";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasCard, CanvasKind } from "../types";

/**
 * The `raise_deck` canvas kind (VIZZY_RAISE_ENABLED): Vizzy drafts a deck for investors or a pack
 * for lenders from chat (`draft`), and changes one (`revise`), each saved as a new draft version
 * a person opens on Content › Raise kit. Nothing is ever sent, shared or submitted.
 *
 * Admins only, as changing a deck is on its page: a token without a role fails closed. Every
 * draft and revise also asks the brand's plan (brandCanUse raise_kit) and its limits, since each
 * one can be a model call. The brand comes from the signed token, and the deck is looked up
 * through it, so another brand's id is simply not found.
 */

const RaiseDeckInput = z.object({
  scope: z
    .object({ kind: z.literal("raise_deck").optional(), docId: z.string().regex(RAISE_DOC_ID).nullish() })
    .optional(),
  mode: z.enum(["draft", "revise"]),
  /** draft */
  audience: z.enum(DECK_AUDIENCES).optional(),
  /** draft, investor only */
  stage: z.enum(INVESTOR_STAGES).optional(),
  title: z.string().trim().max(L.title).optional(),
  /** revise: the version Vizzy read. */
  baseVersion: z.number().int().min(1).optional(),
  note: z.string().trim().max(L.note).optional(),
  /** revise: each checked on its own (revise.ts), so a bad one comes back as invalid_ops. */
  ops: z.array(z.unknown()).min(1).max(5).optional(),
});

export interface RaiseDeckDeps extends StoreDeps {
  draft?: Omit<DraftDeps, keyof StoreDeps>;
  revise?: Omit<ReviseDeps, keyof StoreDeps>;
  granted?: (ctx: TenantContext) => Promise<boolean>;
  limited?: (ctx: TenantContext, limit: RateLimitConfig) => Promise<boolean>;
}

const refused = (status: number, error: string, issues?: unknown[]): CanvasAuthorOutcome => ({ ok: false, status, error, ...(issues?.length ? { issues } : {}) });

/** The card the chat shows: slides, version and how many still need something; checks as its warnings. */
export function deckCard(doc: RaiseDoc): CanvasCard {
  const slides = doc.current.slides;
  return {
    kind: "raise_deck",
    id: doc.id,
    title: doc.title,
    subtitle: kindLabel(doc.audience, doc.stage),
    url: raiseDocHref(doc.id),
    stats: [
      { label: "slides", value: slides.length },
      { label: "version", value: doc.version },
      { label: "needs", value: slides.filter((s) => s.needs.length > 0).length },
    ],
    warnings: deckChecks({ audience: doc.audience, slides }).length,
    note: CARD_NOTE,
    cta: CHAT_WORDS.cta,
  };
}

/** What still needs something and how many checks: the end of every summary. */
function statusLine(doc: RaiseDoc): string {
  const slides = doc.current.slides;
  const waiting = slides.filter((s) => s.needs.length > 0).length;
  const what = [...new Set(slides.flatMap((s) => s.needs.map((n) => n.text)))].slice(0, 6).join(", ");
  const checks = deckChecks({ audience: doc.audience, slides }).length;
  return [waiting ? CHAT_WORDS.needs(waiting, what) : CHAT_WORDS.noNeeds, CHAT_WORDS.checks(checks), CHAT_WORDS.draftOnly].join(" ");
}

function saved(doc: RaiseDoc, summary: string, warnings: string[]): CanvasAuthorOutcome {
  return { ok: true, id: doc.id, status: "draft", url: raiseDocHref(doc.id), summary, warnings, card: deckCard(doc) };
}

export async function authorRaiseDeck({ ctx, input, brief }: CanvasAuthorArgs, deps: RaiseDeckDeps = {}): Promise<CanvasAuthorOutcome> {
  if (!isVizzyRaiseEnabled()) return refused(503, "unavailable");
  // Making and changing decks is for admins, from chat as on the page.
  if (ctx.role !== "admin") return refused(403, "forbidden");
  const parsed = RaiseDeckInput.safeParse(input);
  if (!parsed.success) return refused(400, "invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  const req = parsed.data;
  if (req.mode === "draft" && !req.audience) return refused(400, "invalid_input", ["audience: investor or lender"]);
  if (req.mode === "revise" && !req.ops) return refused(400, "invalid_input", ["ops: at least one change"]);
  if (!(await canUseRaiseKit(ctx, deps))) return refused(403, "not_included");
  const limit = req.mode === "draft" ? DRAFT_LIMIT : onlyRefresh(req.ops ?? []) ? NUMBERS_LIMIT : REVISE_LIMIT;
  if (await overLimit(ctx, limit, deps)) return refused(429, "rate_limited");

  if (req.mode === "draft") {
    if ((await countRaiseDocs(ctx, deps)) >= L.decks) return refused(409, "deck_limit");
    const r = await draftDeck(
      ctx,
      { audience: req.audience!, stage: req.audience === "investor" ? req.stage : undefined, title: req.title, brief: clip(brief, 1500), by: "vizzy" },
      { db: deps.db, now: deps.now, ...deps.draft },
    );
    if (!r.ok) return refused(r.status, r.error);
    const { doc, drafted, warnings } = r.value;
    const first = CHAT_WORDS.drafted(doc.current.slides.length, kindLabel(doc.audience, doc.stage));
    return saved(doc, [first, ...(drafted ? [] : [CHAT_WORDS.outlineOnly]), statusLine(doc)].join(" "), warnings);
  }

  const ops = parseOps(req.ops!);
  if (!ops.ok) return refused(422, "invalid_ops", ops.issues);
  // The deck in view, or the newest.
  const docId = req.scope?.docId ?? (await listRaiseDocs(ctx, deps))[0]?.id;
  const doc = docId ? await readRaiseDoc(ctx, docId, deps) : null;
  if (!doc) return refused(404, "doc_not_found");
  const r = await reviseDeck(ctx, doc, { ops: ops.ops, baseVersion: req.baseVersion ?? doc.version, note: req.note }, { db: deps.db, now: deps.now, ...deps.revise });
  if (!r.ok) return refused(r.status, r.error, r.issues);
  const next = r.value.doc;
  if (!r.value.saved) return saved(next, onlyRefresh(ops.ops) ? CHAT_WORDS.upToDate : CHAT_WORDS.unchanged, r.value.warnings);
  const note = next.changes[0]?.note ?? "";
  return saved(next, [CHAT_WORDS.saved(next.version, note), statusLine(next)].join(" "), r.value.warnings);
}

export const raiseDeckCanvasKind: CanvasKind<"raise_deck"> = {
  kind: "raise_deck",
  label: "Deck or lender pack",
  authorDraft: (args) => authorRaiseDeck(args),
};
