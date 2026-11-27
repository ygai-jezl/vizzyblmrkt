import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getPrompt } from "@/lib/agents/prompts/registry";
import { stampKeyFor } from "@/lib/tenant/loops";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import {
  ARM_LETTER,
  LoopStampSchema,
  MADE_ID_RE,
  MadeIdSchema,
  type LoopArm,
  type LoopStamp,
  type Made,
  type MadeId,
} from "@/lib/types/loopStamp";
import { LOOP_RULES } from "./registry";

/**
 * Stamps (learning loops step 4, decisions 19 and 20 of the plan for steps 4 and 5): made ids
 * built and read, the prompt's part of a stamp, a stamp settled once the image is made, and the
 * signed token a stamp travels in when it goes to the browser and comes back with a save.
 *
 * This is the only file that reads a brand's stamp key (`lk:` in loop_days, minted once through
 * stampKeyFor); stamp.test.ts holds every other file to that. The key never leaves this file: it
 * signs and checks, and nothing here returns it. Server only.
 */

const ARM_OF_LETTER: Record<string, LoopArm> = { l: "learned", h: "holdback", n: "none" };

/** What a made id names: a scope, a learned version and an arm, plus the keyed tail when it has one. */
export interface ParsedMadeId {
  scope: string;
  v: number;
  arm: LoopArm;
  tail: string | null;
}

/** Read a made id (`m1.<scope>.<v>.<l|h|n>`), or null when it isn't one. It names no person and no brand. */
export function parseMadeId(made: unknown): ParsedMadeId | null {
  const ok = MadeIdSchema.safeParse(made);
  if (!ok.success) return null;
  const m = MADE_ID_RE.exec(ok.data)!;
  return { scope: m[1]!, v: Number(m[2]), arm: ARM_OF_LETTER[m[3]!]!, tail: m[4] ?? null };
}

/** The made id for a scope, version and arm; throws on a scope that can't be one (a caller's mistake). */
export function madeIdOf(scope: string, v: number, arm: LoopArm, tail?: string | null): MadeId {
  return MadeIdSchema.parse(`m1.${scope}.${v}.${ARM_LETTER[arm]}${tail ? `.${tail}` : ""}`);
}

/** The longest prompt part a stamp keeps (LoopStampSchema's `prompt`). */
const PROMPT_STAMP_CHARS = 80;

/**
 * A stamp's prompt part: the prompt's id, its version and the first 6 hex characters of a sha256
 * of its template, such as `content.style_profile_synthesize@1#a1b2c3`, so an edit without a
 * version bump still shows. Null for an id the prompt registry doesn't know.
 */
export function promptStamp(promptId: string): string | null {
  let template: string;
  let version: number;
  try {
    ({ template, version } = getPrompt(promptId));
  } catch {
    return null;
  }
  const out = `${promptId}@${version}#${createHash("sha256").update(template).digest("hex").slice(0, 6)}`;
  return out.length <= PROMPT_STAMP_CHARS ? out : null;
}

/** What actually went into an image, known only once it is made. */
export interface StampUse {
  /** The look's words reached the image prompt. */
  lookUsed: boolean;
  /** Style references picked from votes that went with the prompt. */
  refs?: number;
  /** Candidates made to pick the best from; 1, or none, when there was no best of N. */
  bestOf?: number;
  /** A drawn or title card fallback made it, or the painted twin after a drawn render failed. */
  fallbackDrawn?: boolean;
  /**
   * Made on a path that never learns, though it may read a look: a format's card drawn around a
   * painted scene, a drawn style's painted half, or an edit of an earlier image. Arm none, with
   * `not_learning`, so it stays out of every check.
   */
  notLearning?: boolean;
}

/** The sources learnedFor sets, which a settled stamp keeps; settleStamp works out the rest. */
const READ_SOURCES: ReadonlySet<string> = new Set(["legacy", "person_off"]);

const sourceCount = (n: number | undefined): number => (Number.isFinite(n) ? Math.min(99, Math.max(0, Math.floor(n!))) : 0);

/**
 * Settle a stamp where the image is made (decision 3 and 3.3 of the plan), so the arm says what
 * reached the prompt and not only what learnedFor offered:
 * - a drawn fallback is arm none, with `fallback_drawn`;
 * - an image made on a path that never learns (`notLearning`) is arm none, with `not_learning`;
 * - learned with no look in the prompt is arm none, so arm learned always means the look reached it;
 * - held back with a look in the prompt is arm none, since it was no clean holdback;
 * - arm none stays none.
 * The style references and best of N are added to `sources`, and a stamp whose look stayed out
 * keeps no items and no tokens. A thing with no stamp comes back as it was.
 */
export function settleStamp(made: Made, use: StampUse): Made {
  if ("unstamped" in made) return made;
  let arm: LoopArm = made.arm;
  if (use.fallbackDrawn || use.notLearning) arm = "none";
  else if (arm === "learned" && !use.lookUsed) arm = "none";
  else if (arm === "holdback" && use.lookUsed) arm = "none";

  const sources = (made.sources ?? []).filter((s) => READ_SOURCES.has(s));
  const refs = sourceCount(use.refs);
  if (refs > 0) sources.push(`refs:${refs}`);
  const bestOf = sourceCount(use.bestOf);
  if (bestOf > 1) sources.push(`best_of:${bestOf}`);
  // Either keeps the image out of every check; a drawn fallback says the more.
  if (use.fallbackDrawn) sources.push("fallback_drawn");
  else if (use.notLearning) sources.push("not_learning");

  const { sources: _old, ...rest } = made;
  void _old;
  return LoopStampSchema.parse({
    ...rest,
    made: madeIdOf(made.scope, made.v, arm, parseMadeId(made.made)?.tail),
    arm,
    items: use.lookUsed ? made.items : [],
    tokens: use.lookUsed ? made.tokens : { rules: 0, examples: 0 },
    ...(sources.length > 0 ? { sources } : {}),
  }) as LoopStamp;
}

// ----- The signed token (decision 20) -----

const DAY_MS = 86_400_000;
const TOKEN_PREFIX = "st1";
/** A stamp is at most 512 bytes, so a real token is well under this. */
const TOKEN_MAX_CHARS = 2048;

/** Why a token was refused, so the save that brought it can count it. */
export const STAMP_REFUSALS = ["malformed", "signature", "expired", "invalid"] as const;
export type StampRefusal = (typeof STAMP_REFUSALS)[number];

export type VerifiedStamp = { ok: true; stamp: LoopStamp } | { ok: false; reason: StampRefusal };

/** The brand's stamp key: the stored one, or a new random one stored once. Never returned outside this file. */
function brandKey(ctx: TenantContext, db?: FirestoreLike): Promise<string> {
  return stampKeyFor(ctx, () => randomBytes(32).toString("base64url"), db);
}

const signatureOf = (key: string, body: string): Buffer => createHmac("sha256", key).update(body).digest();

/**
 * A stamp as a signed token, for an output handed to the browser that a person saves later. The
 * signature, keyed per brand, covers the whole stamp and its expiry, LOOP_RULES.stampTokenDays
 * after now. The token holds the stamp, which holds no words, person or brand, and never the key.
 */
export async function signStamp(ctx: TenantContext, stamp: LoopStamp, opts: { now?: Date; db?: FirestoreLike } = {}): Promise<string> {
  const s = LoopStampSchema.parse(stamp);
  const e = (opts.now ?? new Date()).getTime() + LOOP_RULES.stampTokenDays * DAY_MS;
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify({ s, e }), "utf8").toString("base64url")}`;
  const key = await brandKey(ctx, opts.db);
  return `${body}.${signatureOf(key, body).toString("base64url")}`;
}

/** A token's two parts, or null when it isn't a token in shape (checked before any key is read). */
function tokenParts(token: unknown): { body: string; payload: string; sig: string } | null {
  if (typeof token !== "string" || token.length > TOKEN_MAX_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return null;
  return { body: `${parts[0]}.${parts[1]}`, payload: parts[1], sig: parts[2] };
}

/** Check one token's signature with the brand's key, then its expiry and the stamp's shape. */
function checkToken(t: { body: string; payload: string; sig: string }, key: string, now: Date): VerifiedStamp {
  const given = Buffer.from(t.sig, "base64url");
  const wanted = signatureOf(key, t.body);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: "signature" };

  let payload: { s?: unknown; e?: unknown };
  try {
    payload = JSON.parse(Buffer.from(t.payload, "base64url").toString("utf8")) as typeof payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.e !== "number") return { ok: false, reason: "invalid" };
  if (now.getTime() > payload.e) return { ok: false, reason: "expired" };
  const s = LoopStampSchema.safeParse(payload.s);
  return s.success ? { ok: true, stamp: s.data as LoopStamp } : { ok: false, reason: "invalid" };
}

/**
 * Check the tokens a save route was sent, before it stores their stamps: each signed with this
 * brand's key, not past its expiry, and a stamp in shape. The key is read once for them all, and
 * only when one is a token in shape, so each token costs one HMAC. Anything else is refused with
 * its reason, for the caller to count; nothing is thrown for a bad token. In the order given.
 */
export async function verifyStamps(ctx: TenantContext, tokens: readonly unknown[], opts: { now?: Date; db?: FirestoreLike } = {}): Promise<VerifiedStamp[]> {
  const parsed = tokens.map(tokenParts);
  const key = parsed.some(Boolean) ? await brandKey(ctx, opts.db) : "";
  const now = opts.now ?? new Date();
  return parsed.map((t) => (t ? checkToken(t, key, now) : { ok: false as const, reason: "malformed" as const }));
}

/** Check one token, as verifyStamps does. */
export async function verifyStamp(ctx: TenantContext, token: unknown, opts: { now?: Date; db?: FirestoreLike } = {}): Promise<VerifiedStamp> {
  return (await verifyStamps(ctx, [token], opts))[0]!;
}
