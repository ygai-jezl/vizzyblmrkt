import { createHash, randomBytes } from "node:crypto";
import { forgetNextActionCard, forTenant, getTenantById, TenantIsolationError } from "@/lib/tenant";
import { bumpBusinessProfileRev, setBusinessProfile } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BusinessProfile, ProfileAnswersInput } from "@/lib/types/businessProfile";
import {
  ONBOARDING_LIMITS,
  isConversationId,
  isFactId,
  readLearned,
  type BusinessFact,
  type ConversationNote,
  type ConversationSource,
  type ConversationSummary,
  type ConversationTurn,
  type EndReason,
  type Learned,
  type OnboardingConversation,
  type VoiceNote,
  type VoiceTurn,
} from "@/lib/types/onboarding";
import { quoteKey } from "./learn";

/**
 * The brand's kept conversations with Vizzy and the facts kept from them (ONBOARDING_ENABLED), in
 * the brand's region through forTenant(ctx). The brand is always the session's: no function here
 * takes a tenant id. Nothing here logs a word anyone said.
 *
 * Erase and export (src/lib/ontology/registry.ts): an admin deletes a conversation
 * (`deleteConversation`) or removes a fact (`removeBusinessFact`); both are read whole in Settings
 * (`getConversation`, `listBusinessFacts`). A fact outlives the conversation it came from.
 */

export interface OnboardingDeps {
  db?: FirestoreLike;
  /** Milliseconds now (tests). */
  now?: () => number;
}

export type OnboardingResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; length?: number };

const L = ONBOARDING_LIMITS;
const conversationsOf = (ctx: TenantContext, deps: OnboardingDeps) => forTenant(ctx, deps.db).onboardingConversations;
const factsOf = (ctx: TenantContext, deps: OnboardingDeps) => forTenant(ctx, deps.db).businessFacts;
const nowMs = (deps: OnboardingDeps) => (deps.now ?? Date.now)();
const iso = (ms: number) => new Date(ms).toISOString();
const fail = (status: number, error: string, extra: { length?: number } = {}): OnboardingResult<never> => ({ ok: false, status, error, ...extra });
const NOT_FOUND = fail(404, "not_found");

/** A claim's plan that answers without writing: keeps the answer for after the transaction. */
function answer<T>(out: { r?: T }, r: T): null {
  out.r = r;
  return null;
}

// ---- Conversations ---------------------------------------------------------------------------

/** A turn as kept: one line, no control characters, within its length. Null when nothing is left. */
function keptTurn(t: VoiceTurn): ConversationTurn | null {
  const text = t.text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, L.MAX_TURN_TEXT)
    .trim();
  if (!text) return null;
  const atSec = Math.min(L.MAX_AT_SEC, Math.max(0, Math.floor(Number.isFinite(t.atSec) ? t.atSec : 0)));
  return { who: t.who === "member" ? "member" : "vizzy", text, atSec };
}

const charsOf = (turns: readonly ConversationTurn[]) => turns.reduce((n, t) => n + t.text.length, 0);

/**
 * The seconds a voice call counts in the usage meter: the time it was open by the server's clock,
 * from its start to its end, at most its token's 6 minutes. Chat counts none.
 */
function meteredSecondsOf(c: Pick<OnboardingConversation, "source" | "startedAt">, endedMs: number): number {
  if (c.source !== "voice") return 0;
  const open = Math.floor((endedMs - Date.parse(c.startedAt)) / 1000);
  return Number.isFinite(open) ? Math.min(L.MAX_CALL_SEC, Math.max(0, open)) : 0;
}

/** The call's length: its last turn, never more than the time it was open, at most 15 minutes. */
function lengthOf(turns: readonly ConversationTurn[], startedAt: string, endedMs: number): number {
  const last = turns.reduce((m, t) => Math.max(m, t.atSec), 0);
  const open = Math.max(0, Math.floor((endedMs - Date.parse(startedAt)) / 1000));
  return Math.min(last, open, L.MAX_AT_SEC);
}

type Merge = { turns: ConversationTurn[]; added: number } | { error: "out_of_order" };

/**
 * New turns from offset `from`: the turns already kept must match, and none may be skipped. A
 * repeat of turns already kept adds nothing.
 */
function mergeTurns(kept: readonly ConversationTurn[], from: number, incoming: readonly VoiceTurn[]): Merge {
  if (!Number.isInteger(from) || from < 0 || from > kept.length) return { error: "out_of_order" };
  const fresh = incoming.map(keptTurn).filter((t): t is ConversationTurn => t !== null);
  for (let i = 0; i < fresh.length && from + i < kept.length; i += 1) {
    const a = kept[from + i]!;
    const b = fresh[i]!;
    if (a.who !== b.who || a.text !== b.text) return { error: "out_of_order" };
  }
  const added = fresh.slice(kept.length - from);
  return { turns: [...kept, ...added], added: added.length };
}

/** Notes added after the kept ones, stamped; one that repeats its topic's latest note is skipped. */
function mergeNotes(kept: readonly ConversationNote[], incoming: readonly VoiceNote[], at: string): ConversationNote[] {
  const out = [...kept];
  for (const n of incoming) {
    const words = n.words?.replace(/\s+/g, " ").trim().slice(0, L.MAX_QUOTE) || undefined;
    const latest = [...out].reverse().find((x) => x.topic === n.topic);
    if (latest && latest.choice === n.choice && (latest.words ?? "") === (words ?? "")) continue;
    out.push({ topic: n.topic, choice: n.choice, ...(words ? { words } : {}), at });
  }
  return out.slice(-L.MAX_NOTES);
}

/** Why this person can't add words to this conversation now, or null when they can. */
function cannotAdd(c: OnboardingConversation, ctx: TenantContext, now: number): OnboardingResult<never> | null {
  if (!ctx.userId || c.by !== ctx.userId) return fail(403, "not_yours");
  if (c.status !== "live") return fail(409, "conversation_closed");
  if (!(now <= Date.parse(c.expiresAt))) return fail(409, "conversation_closed");
  return null;
}

export function newConversationId(): string {
  return `oc_${randomBytes(16).toString("hex")}`;
}

/**
 * Start a conversation for the signed-in member (the voice route, after its checks). Refused at
 * 20 kept conversations: the brand deletes one in Settings to talk again.
 */
export async function startConversation(
  ctx: TenantContext,
  opts: { model: string; source?: ConversationSource },
  deps: OnboardingDeps = {},
): Promise<OnboardingResult<OnboardingConversation>> {
  if (!ctx.userId) return fail(401, "unauthorized");
  const store = conversationsOf(ctx, deps);
  if ((await store.count()) >= L.MAX_CONVERSATIONS) return fail(409, "too_many_conversations");
  const now = nowMs(deps);
  const conversation = await store.create(newConversationId(), {
    source: opts.source ?? "voice",
    by: ctx.userId,
    status: "live",
    startedAt: iso(now),
    expiresAt: iso(now + L.LIVE_WINDOW_MS),
    endedAt: null,
    lengthSec: 0,
    model: opts.model.slice(0, 80),
    turns: [],
    chars: 0,
    notes: [],
    learned: null,
    learnTries: 0,
    confirmedAt: null,
    meteredSeconds: 0,
    createdAt: iso(now),
  });
  return { ok: true, value: conversation };
}

/**
 * Add turns from offset `from` (the count the server already has). Only the member who started it,
 * while it is live and inside its window. A gap is refused with the length kept, a repeat adds
 * nothing, and past 200 turns or 40,000 characters nothing more is taken.
 */
export async function appendTurns(
  ctx: TenantContext,
  id: string,
  input: { from: number; turns: readonly VoiceTurn[]; notes?: readonly VoiceNote[] },
  deps: OnboardingDeps = {},
): Promise<OnboardingResult<{ length: number }>> {
  if (!isConversationId(id)) return NOT_FOUND;
  const now = nowMs(deps);
  const out: { r?: OnboardingResult<{ length: number }> } = {};
  const updated = await conversationsOf(ctx, deps).claim(id, (c) => {
    const refused = cannotAdd(c, ctx, now);
    if (refused) return answer(out, refused);
    const merged = mergeTurns(c.turns ?? [], input.from, input.turns);
    if ("error" in merged) return answer(out, fail(409, "out_of_order", { length: (c.turns ?? []).length }));
    const notes = mergeNotes(c.notes ?? [], input.notes ?? [], iso(now));
    const notesChanged = notes.length !== (c.notes ?? []).length || notes.some((n, i) => n !== c.notes[i]);
    if (!merged.added && !notesChanged) return answer(out, { ok: true, value: { length: merged.turns.length } });
    const chars = charsOf(merged.turns);
    if (merged.turns.length > L.MAX_TURNS || chars > L.MAX_CHARS) return answer(out, fail(413, "conversation_full"));
    return { turns: merged.turns, chars, notes };
  });
  if (out.r) return out.r;
  if (!updated) return NOT_FOUND;
  return { ok: true, value: { length: updated.turns.length } };
}

/**
 * End a conversation (its member only), after an optional last upload, which is dropped when it
 * doesn't fit (a gap, the caps, or the window passed). Ending again changes nothing and says so,
 * so the caller can try learning again. The call that ends it sets the seconds to count
 * (`meteredSeconds`): only that caller records them, so they are counted once.
 */
export async function endConversation(
  ctx: TenantContext,
  id: string,
  input: { reason: EndReason; final?: { from: number; turns: readonly VoiceTurn[]; notes?: readonly VoiceNote[] } },
  deps: OnboardingDeps = {},
): Promise<OnboardingResult<{ conversation: OnboardingConversation; already: boolean }>> {
  if (!isConversationId(id)) return NOT_FOUND;
  const now = nowMs(deps);
  const out: { r?: OnboardingResult<{ conversation: OnboardingConversation; already: boolean }> } = {};
  const updated = await conversationsOf(ctx, deps).claim(id, (c) => {
    if (!ctx.userId || c.by !== ctx.userId) return answer(out, fail(403, "not_yours"));
    if (c.status !== "live") return answer(out, { ok: true, value: { conversation: c, already: true } });
    let turns = c.turns ?? [];
    let notes = c.notes ?? [];
    if (input.final && !cannotAdd(c, ctx, now)) {
      const merged = mergeTurns(turns, input.final.from, input.final.turns);
      if (!("error" in merged) && merged.turns.length <= L.MAX_TURNS && charsOf(merged.turns) <= L.MAX_CHARS) turns = merged.turns;
      notes = mergeNotes(notes, input.final.notes ?? [], iso(now));
    }
    return {
      status: "ended" as const,
      endedAt: iso(now),
      endReason: input.reason,
      lengthSec: lengthOf(turns, c.startedAt, now),
      turns,
      chars: charsOf(turns),
      notes,
      // Set once, by whatever ends the call: the caller records exactly this in the usage meter.
      meteredSeconds: meteredSecondsOf(c, now),
    };
  });
  if (out.r) return out.r;
  if (!updated) return NOT_FOUND;
  return { ok: true, value: { conversation: updated, already: false } };
}

/** How many conversations the brand keeps (at most 20: a new call waits for a delete). */
export async function countConversations(ctx: TenantContext, deps: OnboardingDeps = {}): Promise<number> {
  return conversationsOf(ctx, deps).count();
}

/**
 * Close the brand's live conversations whose window has passed (a tab closed mid call, with no end
 * sent), as of the end of their window. They count the seconds the call evidently ran, its last
 * turn (0 with none), not the whole window: nothing says how long a call nobody ended was open.
 * Returns the ones it closed, so the caller can count them once.
 */
export async function closeStaleConversations(ctx: TenantContext, deps: OnboardingDeps = {}): Promise<OnboardingConversation[]> {
  const now = nowMs(deps);
  const store = conversationsOf(ctx, deps);
  const stale = (await store.find({ limit: L.MAX_CONVERSATIONS + 5 })).filter((c) => c.status === "live" && Date.parse(c.expiresAt) < now);
  const closed: OnboardingConversation[] = [];
  for (const s of stale) {
    const done = await store.claim(s.id, (c) => {
      if (c.status !== "live") return null;
      const endedMs = Math.min(now, Date.parse(c.expiresAt));
      const lengthSec = lengthOf(c.turns ?? [], c.startedAt, endedMs);
      return {
        status: "ended" as const,
        endedAt: iso(endedMs),
        endReason: "closed" as const,
        lengthSec,
        meteredSeconds: c.source === "voice" ? Math.min(L.MAX_CALL_SEC, lengthSec) : 0,
      };
    });
    if (done) closed.push(done);
  }
  return closed;
}

/** Whether learning from this conversation may be tried (ended, nothing learned or kept yet, tries left). */
export function mayLearn(c: Pick<OnboardingConversation, "status" | "learned" | "learnTries" | "confirmedAt">): boolean {
  return c.status === "ended" && !c.learned && !c.confirmedAt && (c.learnTries ?? 0) < L.MAX_LEARN_TRIES;
}

/**
 * Keep what learning gave (null when the model gave nothing), counting the try. What was learned
 * once is never replaced.
 */
export async function saveLearned(
  ctx: TenantContext,
  id: string,
  learned: Learned | null,
  deps: OnboardingDeps = {},
): Promise<OnboardingResult<OnboardingConversation>> {
  if (!isConversationId(id)) return NOT_FOUND;
  const out: { r?: OnboardingResult<OnboardingConversation> } = {};
  const updated = await conversationsOf(ctx, deps).claim(id, (c) => {
    if (c.status !== "ended") return answer(out, fail(409, "not_ended"));
    if (c.learned || c.confirmedAt) return answer(out, { ok: true, value: c });
    return { learnTries: (c.learnTries ?? 0) + 1, ...(learned ? { learned: JSON.parse(JSON.stringify(learned)) as Learned } : {}) };
  });
  if (out.r) return out.r;
  if (!updated) return NOT_FOUND;
  return { ok: true, value: updated };
}

/** The brand's conversations, newest first, without their words. Read whole (at most 25) and sorted here: no index. */
export async function listConversations(ctx: TenantContext, deps: OnboardingDeps = {}): Promise<ConversationSummary[]> {
  const rows = await conversationsOf(ctx, deps).find({ limit: L.MAX_CONVERSATIONS + 5 });
  return rows
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      source: c.source,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt ?? null,
      lengthSec: c.lengthSec ?? 0,
      turnCount: (c.turns ?? []).length,
      waiting: c.status === "ended" && !c.confirmedAt && !!c.learned,
    }));
}

/** One conversation with its words, or null when this brand has none by that id (export path). */
export async function getConversation(ctx: TenantContext, id: string, deps: OnboardingDeps = {}): Promise<OnboardingConversation | null> {
  if (!isConversationId(id)) return null;
  return conversationsOf(ctx, deps).getById(id);
}

/**
 * Home's Your next action is written from what the brand kept, so it goes too, with its outcomes
 * (src/lib/tenant/nextActionCards.ts), and the next visit to Home writes a new one. It never fails
 * the delete it follows.
 */
async function forgetCardAfter(ctx: TenantContext, deps: OnboardingDeps): Promise<void> {
  await forgetNextActionCard(ctx, { at: iso(nowMs(deps)), by: { type: "member", id: ctx.userId ?? null }, db: deps.db }).catch(() => {
    console.warn("[onboarding] Your next action was not cleared after a delete");
  });
}

/**
 * Delete a conversation: its words and what was learned from it go for good. Facts already kept
 * from it stay until they are removed (erase path). Home's Your next action goes too.
 */
export async function deleteConversation(ctx: TenantContext, id: string, deps: OnboardingDeps = {}): Promise<OnboardingResult<true>> {
  if (!isConversationId(id)) return NOT_FOUND;
  const store = conversationsOf(ctx, deps);
  if (!(await store.getById(id))) return NOT_FOUND;
  await store.delete(id);
  await forgetCardAfter(ctx, deps);
  return { ok: true, value: true };
}

// ---- Facts -----------------------------------------------------------------------------------

/** A kept fact's id: the same for the same fact of the same conversation, so keeping it twice can't add it twice. */
function factIdFor(tenantId: string, conversationId: string, learnedId: string): string {
  return `bf_${createHash("sha256").update(`${tenantId}:${conversationId}:${learnedId}`).digest("hex").slice(0, 16)}`;
}

/** The brand's kept facts, oldest first (as they were heard and kept). Read whole (at most 45) and sorted here (export path). */
export async function listBusinessFacts(ctx: TenantContext, deps: OnboardingDeps = {}): Promise<BusinessFact[]> {
  const rows = await factsOf(ctx, deps).find({ limit: L.MAX_FACTS + 5 });
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Remove a kept fact: its words go for good, Vizzy reads the profile again, and Home's Your next
 * action, which may quote it, goes too (erase path).
 */
export async function removeBusinessFact(ctx: TenantContext, id: string, deps: OnboardingDeps = {}): Promise<OnboardingResult<true>> {
  if (!isFactId(id)) return NOT_FOUND;
  const store = factsOf(ctx, deps);
  if (!(await store.getById(id))) return NOT_FOUND;
  await store.delete(id);
  await bumpBusinessProfileRev(ctx.tenantId, deps.db).catch(() => null);
  await forgetCardAfter(ctx, deps);
  return { ok: true, value: true };
}

export interface Confirmed {
  /** The brand's profile before this confirm (null when there was none). */
  before: BusinessProfile | null;
  profile: BusinessProfile | null;
  /** The facts this confirm kept. */
  kept: BusinessFact[];
  /** Picked facts the brand already had (the same words). */
  duplicate: number;
  /** True when the brand's 40 facts stopped any. */
  full: boolean;
  /** True when this conversation was confirmed before: nothing was written. */
  repeat: boolean;
}

/**
 * "Looks right": save the answers to the brand's profile (done, from the call) and keep the picked
 * facts. The facts are copied from what this conversation learned, by id: the request never gives
 * a fact's words. A fact with the same words as one already kept is skipped, and the brand keeps
 * at most 40. Confirming again adds nothing.
 */
export async function confirmLearned(
  ctx: TenantContext,
  id: string,
  input: { answers: ProfileAnswersInput; keep: readonly string[] },
  deps: OnboardingDeps = {},
): Promise<OnboardingResult<Confirmed>> {
  const conversation = await getConversation(ctx, id, deps);
  if (!conversation) return NOT_FOUND;
  if (conversation.status !== "ended") return fail(409, "not_ended");
  if (conversation.confirmedAt) {
    const tenant = await getTenantById(ctx.tenantId, deps.db);
    const profile = tenant?.businessProfile ?? null;
    return { ok: true, value: { before: profile, profile, kept: [], duplicate: 0, full: false, repeat: true } };
  }

  const now = nowMs(deps);
  const at = iso(now);
  const wanted = new Set(input.keep);
  const picked = (readLearned(conversation.learned)?.facts ?? []).filter((f) => wanted.has(f.id));
  const existing = await listBusinessFacts(ctx, deps);
  const seen = new Set(existing.map((f) => quoteKey(f.quote)));
  let count = existing.length;
  let duplicate = 0;
  let full = false;
  const kept: BusinessFact[] = [];
  for (const f of picked) {
    const key = quoteKey(f.quote);
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    if (count >= L.MAX_FACTS) {
      full = true;
      break;
    }
    try {
      const fact = await factsOf(ctx, deps).create(factIdFor(ctx.tenantId, conversation.id, f.id), {
        kind: f.kind,
        text: f.text,
        quote: f.quote,
        source: conversation.source,
        conversationId: conversation.id,
        heardAt: conversation.startedAt,
        confirmedAt: at,
        // A millisecond apart, so they list in the order Vizzy heard them.
        createdAt: iso(now + kept.length),
      });
      kept.push(fact);
      seen.add(key);
      count += 1;
    } catch (err) {
      // Kept already by a confirm running at the same moment.
      if (!(err instanceof TenantIsolationError)) throw err;
      duplicate += 1;
    }
  }

  await conversationsOf(ctx, deps).claim(conversation.id, (c) => (c.confirmedAt ? null : { confirmedAt: at }));
  const saved = await setBusinessProfile(
    ctx.tenantId,
    { answers: input.answers, status: "done", ...(conversation.source === "voice" ? { via: "voice" as const } : {}) },
    deps.db,
  );
  if (!saved) return NOT_FOUND;
  let profile = saved.after;
  if (kept.length) {
    const rev = await bumpBusinessProfileRev(ctx.tenantId, deps.db);
    if (rev !== null) profile = { ...profile, rev };
  }
  return { ok: true, value: { before: saved.before, profile, kept, duplicate, full, repeat: false } };
}
