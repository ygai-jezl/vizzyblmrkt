import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { removeFromIndex } from "@/lib/search/indexer";
import { forTenant, transitionAgentAction } from "@/lib/tenant";
import { loopDayId, readBrandPointers, readBrandPointersTx, readLoopDays, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx, excludeOnVersionTx, getPatternVersion, listPatternVersions, readPatternVersionTx, removeWordsTx } from "@/lib/tenant/patternVersions";
import { getTenantPageRow, type TenantPageRow } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext, TransactionLike } from "@/lib/tenant/types";
import { isAgentActionId, type AgentAction } from "@/lib/types/agentAction";
import type { EventActor } from "@/lib/ontology/events";
import { EVIDENCE_IDS_MAX, type LearnedItem, type LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";
import { VersionTotalsSchema, type BrandPointers } from "@/lib/types/loopDay";
import { goBackOf, supersedeGoBackCards } from "./cards";
import { clearOldCopy } from "./oldCopy";
import { countCard, countVersionSignal } from "./count";
import { BRAND_SCOPE } from "./read";
import { IMAGE_STYLE_SCOPES, type ImageStyleScope } from "./registry";
import { LOOK_REFUSED_MESSAGE } from "./textCheck";
import { newestRead } from "./verdictWords";
import { checkLookText, lookHash } from "./write";

/**
 * The person actions on what image style learned (learning loops step 4, 3.5 of the plan for
 * steps 4 and 5), behind POST /api/admin/brand-kit/image-style/learned: Undo, Pause and Resume,
 * Forget, Edit the words, Keep this look, Go back and Resume suggestions. Admins only (the route
 * checks), and only with image style versions on. Each that moves a look writes a new version
 * row and the brand's pointer (`lb:`) in one regional transaction, so the two never disagree;
 * `by` comes from the signed in member, onto the row.
 *
 * - Undo writes the version before's look again as a new version (undoing a first look leaves no
 *   look), leaves out the likes that made the undone look due, counts undone, and closes an open
 *   Go back card for the scope. It is refused on a Forget, or when the look it would restore had
 *   its words removed.
 * - Forget writes a version with no look, leaves out all of the forgotten look's evidence, takes
 *   the words out of every older row of the scope that held them, then clears the scope's old copy
 *   on the brand record and its search entry, and closes open cards. The lane tries the old copy
 *   again until it is gone. It can also forget the brand look, when the two learned from the same
 *   images.
 * - Edit the words writes a look set by a person, which is never held back and which the learner
 *   leaves alone; the same text check as the learner's refuses links, email addresses, handles and
 *   phone numbers, and the person sees LOOK_REFUSED_MESSAGE.
 * - Keep puts keptAt on the pointer with no new version; Go back writes the named earlier
 *   version's look again. Both answer a Go back card, or the worse read on the card's own notice.
 * Server only.
 */

export type LearnedOp = "undo" | "pause" | "resume" | "forget" | "forget_undone" | "edit" | "keep" | "go_back" | "resume_suggestions" | "help_check";

export type ActionError =
  | "switch"
  | "scope"
  | "nothing_to_undo"
  | "nothing_to_forget"
  | "forgotten"
  | "words_removed"
  | "moved"
  | "not_found"
  | "not_worse"
  | "text_refused"
  | "write_failed";

export type ActionResult =
  | {
      ok: true;
      v?: number;
      /** Undo and Go back: the version whose look came back (0 for none), when it was made, and whether the look left was set by a person. */
      restored?: number;
      restoredAt?: string | null;
      wasPerson?: boolean;
      scopes?: string[];
      /** The learning setting: when the brand turned Help check that learning works off, or null while it is on. */
      offSince?: string | null;
    }
  | { ok: false; error: ActionError; message?: string };

export interface ActionDeps {
  db?: FirestoreLike;
  now?: Date;
  /** The control plane database, for the old copy on the brand record (tests pass a fake). */
  controlDb?: FirestoreLike;
  /** Remove a look from the brand's search (removeFromIndex by default). */
  removeSearch?: (ctx: TenantContext, ref: string) => Promise<unknown>;
}

const isLearningScope = (scope: unknown): scope is ImageStyleScope => typeof scope === "string" && (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

const fail = (error: ActionError, message?: string): ActionResult => ({ ok: false, error, ...(message ? { message } : {}) });

/** The member who acted, as the version row keeps it: an id, never an address. */
function byOf(ctx: TenantContext): string | undefined {
  const id = ctx.userId;
  return id && !id.includes("@") ? id.slice(0, 128) : undefined;
}

function actorOf(ctx: TenantContext): EventActor {
  const id = byOf(ctx) ?? null;
  return { type: "member", id };
}

/** A version row's look: its rule item with words. */
function lookOf(row: LearnedPatternVersion | null): LearnedItem | null {
  return row?.items?.find((i) => i.type === "rule" && typeof i.text === "string" && i.text.trim().length > 0) ?? null;
}

/** Whether a row once held words that a Forget took out. */
const wordsRemoved = (row: LearnedPatternVersion | null): boolean => Boolean(row?.items?.length) && !lookOf(row);

/** The search entry of a look in use: `image_style.<style>@<version>`. */
export const lookSearchRef = (scope: string, v: number): string => `${scope}@${v}`;

type VersionInput = Omit<LearnedPatternVersion, "id" | "tenantId">;

function versionRow(scope: string, v: number, at: string, rest: Partial<VersionInput> & Pick<VersionInput, "createdBy" | "setBy" | "items" | "change">): VersionInput {
  return {
    channel: scope,
    version: v,
    directive: null,
    perform: [],
    avoid: [],
    judgeRationale: "",
    evidence: [],
    createdAt: at,
    loop: "image_style",
    ...rest,
  };
}

/** Run a change in one regional transaction; a failed commit is a write_failed, never a throw. */
async function inTransaction(ctx: TenantContext, deps: ActionDeps, fn: (txn: TransactionLike) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await runLoopsTransaction(ctx, fn, deps.db);
  } catch (err) {
    console.warn("[loops] a person's change to a learned look failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return fail("write_failed");
  }
}

function guard(scope: unknown): ActionResult | null {
  if (!isImageStyleVersionsOn()) return fail("switch");
  if (!isLearningScope(scope)) return fail("scope");
  return null;
}

/** The liked evidence of a look that came in after the look before began: what made it due. */
async function triggerLikes(ctx: TenantContext, row: LearnedPatternVersion, prevAt: string | null, db?: FirestoreLike): Promise<string[]> {
  const ids = row.evidenceIds ?? [];
  if (ids.length === 0) return [];
  const repo = forTenant(ctx, db).imageAssets;
  const rows = await Promise.all(ids.map((id) => repo.getById(id)));
  return rows
    .filter((r) => r?.brandVote === "up" && (!prevAt || (r.firstVotedAt ?? r.brandVoteSetAt ?? r.createdAt) > prevAt))
    .map((r) => r!.id)
    .slice(0, EVIDENCE_IDS_MAX);
}

/**
 * Write the look of version `to` again as the scope's next version (Undo and Go back), after
 * checking in the transaction that the scope still uses `from`.
 */
async function restore(
  ctx: TenantContext,
  scope: string,
  input: { from: number; to: number; createdBy: "undo" | "revert"; excluded: string[] },
  deps: ActionDeps,
): Promise<ActionResult> {
  const at = (deps.now ?? new Date()).toISOString();
  return inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    const cur = pointers.scopes[scope];
    if (!cur || cur.v !== input.from) return fail("moved");
    const [curRow, target] = await Promise.all([
      readPatternVersionTx(txn, ctx, scope, input.from, deps.db),
      input.to > 0 ? readPatternVersionTx(txn, ctx, scope, input.to, deps.db) : Promise.resolve(null),
    ]);
    if (curRow?.createdBy === "forget") return fail("forgotten");
    if (input.to > 0 && (!target || wordsRemoved(target))) return fail("words_removed");
    const look = lookOf(target);
    const v = input.from + 1;
    const setBy = look ? (target?.setBy ?? "learned") : "learned";
    appendPatternVersionTx(
      txn,
      ctx,
      versionRow(scope, v, at, {
        createdBy: input.createdBy,
        setBy,
        items: look ? [{ ...look }] : [],
        change: { op: "revert", itemId: look?.id ?? lookOf(curRow)?.id ?? `look${input.from}` },
        ...(input.excluded.length ? { excludedEvidence: input.excluded.slice(0, EVIDENCE_IDS_MAX) } : {}),
        ...(target?.evidenceCounts && look ? { evidenceCounts: target.evidenceCounts } : {}),
        ...(byOf(ctx) ? { by: byOf(ctx) } : {}),
      }),
      deps.db,
    );
    writeBrandPointersTx(txn, ctx, { ...pointers, scopes: { ...pointers.scopes, [scope]: { v, setBy, adoptedAt: at } } }, deps.db);
    return { ok: true, v, restored: input.to, restoredAt: target?.createdAt ?? null, wasPerson: curRow?.setBy === "person" };
  });
}

/** Undo: the look before comes back as a new version, and the likes that made the undone look due are left out from now on. */
export async function undoLook(ctx: TenantContext, scope: unknown, deps: ActionDeps = {}): Promise<ActionResult> {
  const blocked = guard(scope);
  if (blocked) return blocked;
  const s = scope as ImageStyleScope;
  const pointers = await readBrandPointers(ctx, deps.db);
  const cur = pointers.scopes[s];
  if (!cur || cur.v <= 0) return fail("nothing_to_undo");
  const [curRow, prevRow] = await Promise.all([getPatternVersion(ctx, s, cur.v, deps.db), cur.v > 1 ? getPatternVersion(ctx, s, cur.v - 1, deps.db) : Promise.resolve(null)]);
  if (!curRow) return fail("not_found");
  if (curRow.createdBy === "forget") return fail("forgotten");
  const excluded = curRow.setBy === "learned" ? await triggerLikes(ctx, curRow, prevRow?.createdAt ?? null, deps.db) : [];
  const r = await restore(ctx, s, { from: cur.v, to: cur.v - 1, createdBy: "undo", excluded }, deps);
  if (r.ok) {
    await countVersionSignal(ctx, s, cur.v, "undone", { db: deps.db, now: deps.now });
    await supersedeGoBackCards(ctx, s, actorOf(ctx), { db: deps.db, now: deps.now });
  }
  return r;
}

/** Pause or resume image learning: whatever look is in use stays in use, and nothing new is learned or profiled until Resume. */
export async function setImageLearningPaused(ctx: TenantContext, paused: boolean, deps: ActionDeps = {}): Promise<ActionResult> {
  if (!isImageStyleVersionsOn()) return fail("switch");
  const at = (deps.now ?? new Date()).toISOString();
  return inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    const next: BrandPointers = { ...pointers };
    if (paused) next.pause = { ...(pointers.pause ?? {}), image_style: pointers.pause?.image_style ?? { at } };
    else if (pointers.pause) {
      const { image_style: _was, ...rest } = pointers.pause;
      void _was;
      next.pause = rest;
    }
    writeBrandPointersTx(txn, ctx, next, deps.db);
    return { ok: true };
  });
}

/** Resume Go back suggestions after the attention rule dropped them to a notice: only weeks from now count. */
export async function resumeSuggestions(ctx: TenantContext, deps: ActionDeps = {}): Promise<ActionResult> {
  if (!isImageStyleVersionsOn()) return fail("switch");
  const at = (deps.now ?? new Date()).toISOString();
  return inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    writeBrandPointersTx(txn, ctx, { ...pointers, cardsResumedAt: at }, deps.db);
    return { ok: true };
  });
}

/** Edit the words: a look set by a person, always used, never held back, and left alone by the learner. */
export async function editLook(ctx: TenantContext, scope: unknown, text: unknown, deps: ActionDeps = {}): Promise<ActionResult> {
  const blocked = guard(scope);
  if (blocked) return blocked;
  const s = scope as ImageStyleScope;
  const words = checkLookText(text);
  if (!words.ok) return fail("text_refused", words.reason === "trust" ? LOOK_REFUSED_MESSAGE : undefined);
  const at = (deps.now ?? new Date()).toISOString();
  const r = await inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    const cur = pointers.scopes[s];
    const curRow = cur && cur.v > 0 ? await readPatternVersionTx(txn, ctx, s, cur.v, deps.db) : null;
    const v = (cur?.v ?? 0) + 1;
    const itemId = `look${v}`;
    appendPatternVersionTx(
      txn,
      ctx,
      versionRow(s, v, at, {
        createdBy: "person",
        setBy: "person",
        items: [{ id: itemId, type: "rule", text: words.text, trust: "person", from: "person" }],
        change: { op: lookOf(curRow) ? "edit" : "add", itemId },
        ...(byOf(ctx) ? { by: byOf(ctx) } : {}),
      }),
      deps.db,
    );
    writeBrandPointersTx(txn, ctx, { ...pointers, scopes: { ...pointers.scopes, [s]: { v, setBy: "person", adoptedAt: at } } }, deps.db);
    return { ok: true, v };
  });
  if (r.ok) await supersedeGoBackCards(ctx, s, actorOf(ctx), { db: deps.db, now: deps.now });
  return r;
}

/** Forget's counts for its confirm: the images that taught the look, and how many of them also taught the brand look. */
export async function forgetPreview(
  ctx: TenantContext,
  scope: unknown,
  deps: ActionDeps = {},
): Promise<{ ok: true; liked: number; disliked: number; uploaded: number; brandOverlap: number } | { ok: false; error: ActionError }> {
  const blocked = guard(scope);
  if (blocked) return blocked as { ok: false; error: ActionError };
  const s = scope as ImageStyleScope;
  const pointers = await readBrandPointers(ctx, deps.db);
  const cur = pointers.scopes[s];
  const brand = s === BRAND_SCOPE ? undefined : pointers.scopes[BRAND_SCOPE];
  const [row, brandRow] = await Promise.all([
    cur && cur.v > 0 ? getPatternVersion(ctx, s, cur.v, deps.db) : Promise.resolve(null),
    brand && brand.v > 0 ? getPatternVersion(ctx, BRAND_SCOPE, brand.v, deps.db) : Promise.resolve(null),
  ]);
  if (!lookOf(row)) return { ok: false, error: "nothing_to_forget" };
  const brandIds = new Set(lookOf(brandRow) ? (brandRow?.evidenceIds ?? []) : []);
  return {
    ok: true,
    liked: row?.evidenceCounts?.liked ?? 0,
    disliked: row?.evidenceCounts?.disliked ?? 0,
    uploaded: row?.evidenceCounts?.uploaded ?? 0,
    brandOverlap: (row?.evidenceIds ?? []).filter((id) => brandIds.has(id)).length,
  };
}

/** The brand record as the old copy's clearing needs it. */
function oldCopyRow(ctx: TenantContext, deps: ActionDeps): Promise<TenantPageRow | null> {
  return getTenantPageRow(ctx.tenantId, deps.controlDb).catch(() => null);
}

/** Forget one scope's look, in its own transaction. */
async function forgetOne(ctx: TenantContext, scope: ImageStyleScope, deps: ActionDeps): Promise<ActionResult> {
  const at = (deps.now ?? new Date()).toISOString();
  const pointers = await readBrandPointers(ctx, deps.db);
  const cur = pointers.scopes[scope];
  if (!cur || cur.v <= 0) return fail("nothing_to_forget");
  const curRow = await getPatternVersion(ctx, scope, cur.v, deps.db);
  const look = lookOf(curRow);
  if (!curRow || !look) return fail("nothing_to_forget");
  const words = look.text!.trim();
  // Every older row of the scope that holds the same words (an Undo copies them).
  const history = await listPatternVersions(ctx, scope, 50, deps.db);
  const holding = history.filter((r) => r.version <= cur.v && r.items?.some((i) => typeof i.text === "string" && i.text.trim() === words)).map((r) => r.version);
  const evidence = (curRow.evidenceIds ?? []).slice(0, EVIDENCE_IDS_MAX);

  const r = await inTransaction(ctx, deps, async (txn) => {
    const now = await readBrandPointersTx(txn, ctx, deps.db);
    if (now.scopes[scope]?.v !== cur.v) return fail("moved");
    const rows = await Promise.all(holding.map((v) => readPatternVersionTx(txn, ctx, scope, v, deps.db)));
    const v = cur.v + 1;
    for (const row of rows) if (row) removeWordsTx(txn, ctx, row, deps.db);
    appendPatternVersionTx(
      txn,
      ctx,
      versionRow(scope, v, at, {
        createdBy: "forget",
        setBy: "learned",
        items: [],
        change: { op: "retire", itemId: look.id },
        forgotHash: lookHash(words),
        ...(evidence.length ? { excludedEvidence: evidence } : {}),
        ...(byOf(ctx) ? { by: byOf(ctx) } : {}),
      }),
      deps.db,
    );
    writeBrandPointersTx(
      txn,
      ctx,
      { ...now, scopes: { ...now.scopes, [scope]: { v, setBy: "learned", adoptedAt: at } }, forgot: { ...(now.forgot ?? {}), [scope]: { at } } },
      deps.db,
    );
    return { ok: true, v };
  });
  if (!r.ok) return r;
  const remove = deps.removeSearch ?? ((c: TenantContext, ref: string) => removeFromIndex(c, "learned", ref));
  for (const v of holding) await Promise.resolve(remove(ctx, lookSearchRef(scope, v))).catch(() => undefined);
  await clearOldCopy(ctx, await oldCopyRow(ctx, deps), scope, at, deps);
  await supersedeGoBackCards(ctx, scope, actorOf(ctx), { db: deps.db, now: deps.now });
  return r;
}

/**
 * Forget: never learn this look again. With `alsoBrand`, the brand look goes too when the two
 * learned from the same images.
 */
export async function forgetLook(ctx: TenantContext, scope: unknown, opts: { alsoBrand?: boolean } = {}, deps: ActionDeps = {}): Promise<ActionResult> {
  const blocked = guard(scope);
  if (blocked) return blocked;
  const s = scope as ImageStyleScope;
  const r = await forgetOne(ctx, s, deps);
  if (!r.ok || !opts.alsoBrand || s === BRAND_SCOPE) return r.ok ? { ...r, scopes: [s] } : r;
  const brand = await forgetOne(ctx, BRAND_SCOPE, deps);
  return { ...r, scopes: brand.ok ? [s, BRAND_SCOPE] : [s] };
}

/**
 * "Don't learn this again: Forget", offered on Undo's done line: never learn again the look an Undo
 * just left, from the images that taught it. The look in use (the one Undo put back) stays as it
 * is: the undone version's words come out of every row that held them, and the Undo's own row
 * gains the undone look's evidence as left out, with the hash of its words, so the learner never
 * proposes it again (the learner reads every row's excludedEvidence and forgotHash). When the
 * undone look was the one carried over from before versions, its old copy on the brand record is
 * cleared as well, as Forget does.
 */
export async function forgetUndone(ctx: TenantContext, scope: unknown, deps: ActionDeps = {}): Promise<ActionResult> {
  const blocked = guard(scope);
  if (blocked) return blocked;
  const s = scope as ImageStyleScope;
  const at = (deps.now ?? new Date()).toISOString();
  const pointers = await readBrandPointers(ctx, deps.db);
  const cur = pointers.scopes[s];
  if (!cur || cur.v < 2) return fail("nothing_to_forget");
  const [curRow, undone] = await Promise.all([getPatternVersion(ctx, s, cur.v, deps.db), getPatternVersion(ctx, s, cur.v - 1, deps.db)]);
  if (curRow?.createdBy !== "undo") return fail("nothing_to_forget");
  const look = lookOf(undone);
  if (!undone || !look) return fail("nothing_to_forget");
  const words = look.text!.trim();
  const history = await listPatternVersions(ctx, s, 50, deps.db);
  const holding = history.filter((r) => r.version < cur.v && r.items?.some((i) => typeof i.text === "string" && i.text.trim() === words)).map((r) => r.version);
  const seeded = undone.setBy === "seeded" || undone.createdBy === "seed";
  const evidence = [...new Set([...(curRow.excludedEvidence ?? []), ...(undone.evidenceIds ?? [])])].slice(0, EVIDENCE_IDS_MAX);

  const r = await inTransaction(ctx, deps, async (txn) => {
    const now = await readBrandPointersTx(txn, ctx, deps.db);
    if (now.scopes[s]?.v !== cur.v) return fail("moved");
    const rows = await Promise.all(holding.map((v) => readPatternVersionTx(txn, ctx, s, v, deps.db)));
    for (const row of rows) if (row) removeWordsTx(txn, ctx, row, deps.db);
    excludeOnVersionTx(txn, ctx, curRow, { excludedEvidence: evidence, forgotHash: lookHash(words) }, deps.db);
    if (seeded) writeBrandPointersTx(txn, ctx, { ...now, forgot: { ...(now.forgot ?? {}), [s]: { at } } }, deps.db);
    return { ok: true, v: cur.v };
  });
  if (!r.ok) return r;
  const remove = deps.removeSearch ?? ((c: TenantContext, ref: string) => removeFromIndex(c, "learned", ref));
  for (const v of holding) await Promise.resolve(remove(ctx, lookSearchRef(s, v))).catch(() => undefined);
  if (seeded) await clearOldCopy(ctx, await oldCopyRow(ctx, deps), s, at, deps);
  return { ...r, scopes: [s] };
}

/**
 * The learning setting, Help check that learning works (screen 5): off puts `fleetOptOut` on the
 * brand's pointers, so no image of the brand is held back (and, from step 5, the brand is left out
 * of counts across brands); on takes it away. The brand's own learning carries on either way.
 */
export async function setHelpCheck(ctx: TenantContext, on: boolean, deps: ActionDeps = {}): Promise<ActionResult> {
  if (!isImageStyleVersionsOn()) return fail("switch");
  const at = (deps.now ?? new Date()).toISOString();
  return inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    if (on) {
      const { fleetOptOut: _was, ...rest } = pointers;
      void _was;
      writeBrandPointersTx(txn, ctx, rest, deps.db);
      return { ok: true, offSince: null };
    }
    const offSince = pointers.fleetOptOut?.at ?? at;
    writeBrandPointersTx(txn, ctx, { ...pointers, fleetOptOut: { at: offSince } }, deps.db);
    return { ok: true, offSince };
  });
}

/** The card a Keep or Go back answers, or the scope's worse read on the card's own notice. */
async function answerOf(
  ctx: TenantContext,
  input: { cardId?: unknown; scope?: unknown },
  deps: ActionDeps,
): Promise<{ ok: true; scope: ImageStyleScope; from: number; to: number; card: AgentAction | null } | { ok: false; error: ActionError }> {
  if (!isImageStyleVersionsOn()) return { ok: false, error: "switch" };
  if (input.cardId !== undefined) {
    if (!isAgentActionId(input.cardId)) return { ok: false, error: "not_found" };
    const card = await getAgentAction(ctx, input.cardId, { db: deps.db });
    const g = card ? goBackOf(card) : null;
    if (!card || !g || !isLearningScope(g.scope)) return { ok: false, error: "not_found" };
    if (card.state !== "proposed") return { ok: false, error: "moved" };
    return { ok: true, scope: g.scope, from: g.from, to: g.to, card };
  }
  if (!isLearningScope(input.scope)) return { ok: false, error: "scope" };
  const pointers = await readBrandPointers(ctx, deps.db);
  const cur = pointers.scopes[input.scope];
  if (!cur || cur.v <= 0) return { ok: false, error: "not_found" };
  const [doc] = await readLoopDays(ctx, [loopDayId.version(ctx.tenantId, input.scope, cur.v)], deps.db);
  const totals = VersionTotalsSchema.safeParse(doc?.d ?? {});
  if (newestRead(totals.success ? totals.data.looks : undefined)?.call !== "worse") return { ok: false, error: "not_worse" };
  return { ok: true, scope: input.scope, from: cur.v, to: cur.v - 1, card: null };
}

/** Keep this look: keptAt on the pointer, no new version, so the windows carry on; a card asks again only if a later check reads worse. */
export async function keepLook(ctx: TenantContext, input: { cardId?: unknown; scope?: unknown }, deps: ActionDeps = {}): Promise<ActionResult> {
  const a = await answerOf(ctx, input, deps);
  if (!a.ok) return fail(a.error);
  const at = (deps.now ?? new Date()).toISOString();
  const r = await inTransaction(ctx, deps, async (txn) => {
    const pointers = await readBrandPointersTx(txn, ctx, deps.db);
    const cur = pointers.scopes[a.scope];
    if (!cur || cur.v !== a.from) return fail("moved");
    writeBrandPointersTx(txn, ctx, { ...pointers, scopes: { ...pointers.scopes, [a.scope]: { ...cur, keptAt: at } } }, deps.db);
    return { ok: true, v: cur.v };
  });
  if (r.ok && a.card) {
    const t = await transitionAgentAction(ctx, a.card.id, { to: "declined", reason: "dismissed", by: actorOf(ctx), at, expectRev: a.card.rev }, { db: deps.db });
    if (t.ok) await countCard(ctx, "loop_learn", "declined", { db: deps.db, now: deps.now });
  }
  return r;
}

/** Go back: the named earlier version's look comes back as a new version, refused once the scope moved on. */
export async function goBackLook(ctx: TenantContext, input: { cardId?: unknown; scope?: unknown }, deps: ActionDeps = {}): Promise<ActionResult> {
  const a = await answerOf(ctx, input, deps);
  if (!a.ok) return fail(a.error);
  const r = await restore(ctx, a.scope, { from: a.from, to: a.to, createdBy: "revert", excluded: [] }, deps);
  if (!r.ok) return r;
  const at = (deps.now ?? new Date()).toISOString();
  await countVersionSignal(ctx, a.scope, a.from, "reversed", { db: deps.db, now: deps.now });
  if (a.card) {
    const t = await transitionAgentAction(ctx, a.card.id, { to: "acted", by: actorOf(ctx), at, expectRev: a.card.rev, result: { v: r.v ?? null } }, { db: deps.db });
    if (t.ok) await countCard(ctx, "loop_learn", "acted", { db: deps.db, now: deps.now });
  }
  return r;
}
