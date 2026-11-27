import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { LoopStamp, Made } from "@/lib/types/loopStamp";
import { CountBuffer, countMade, countsFor } from "./count";
import type { LoopKind } from "./registry";
import { signStamp, verifyStamps } from "./stamp";

/**
 * Outputs handed to the browser and saved later (learning loops step 5, decision 20 and 4.2 of the
 * plan for steps 4 and 5): email assist, Edit mode Vizzy, the brand voice and brand kit drafts,
 * notes extract, Suggest an angle, the email layout and the email images. The route that makes
 * one counts it made once; for a kind whose save checks a token (TOKEN_SAVES) it also hands back
 * its stamp as a signed token beside the output, and the save route checks the token before it
 * stores what the person saved.
 *
 * With the kind's switch off (decision 22) nothing is counted, signed or read: no token goes out,
 * and a save reads no key. A token is good for LOOP_RULES.stampTokenDays and its signature covers
 * the whole stamp, so a save can't change one; a member replaying a valid token onto their own
 * handwritten save skews only their own brand's counts (4.2). Server only.
 */

export interface HandBackDeps {
  db?: FirestoreLike;
  now?: Date;
  /** The ontology type of what was made, for `t.<type>.made`. */
  type?: string;
}

/** The most tokens one save checks: each is one HMAC, with one key read and one count write for the save. */
export const SAVE_TOKENS_MAX = 20;

/**
 * The kinds whose save checks a stamp token today: brand voice, the brand kit (its extract and the
 * colours kept from a source, both saved with Brand settings) and brand notes. Every other hand
 * back (email assist, Edit mode Vizzy, the email layout, hero and block image, Suggest an angle)
 * counts made but signs no token, since no save would check it, and a token would read the
 * brand's key for nothing. A kind joins once its save sends `x-stamp-tokens` and checks them.
 */
export const TOKEN_SAVES: ReadonlySet<LoopKind> = new Set<LoopKind>(["brand_voice", "brand_kit", "brand_notes"]);

/**
 * Count a made thing handed to the browser and, for a kind whose save checks one (TOKEN_SAVES),
 * sign its stamp for that save. Null when it has no stamp, its kind's switch is off, its save
 * checks no token, or signing failed (logged; the output still goes).
 */
export async function handBack(ctx: TenantContext, kind: LoopKind, made: Made, deps: HandBackDeps = {}): Promise<string | null> {
  if (!countsFor(kind)) return null;
  await countMade(ctx, kind, made, deps);
  if ("unstamped" in made || !TOKEN_SAVES.has(kind)) return null;
  return signStamp(ctx, made, deps).catch((err) => {
    console.warn(`[loops] signing the stamp for ${kind} failed`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  });
}

/** The JSON a hand-off answers with: the body, plus `stampToken` only when there is one, so off is today exactly. */
export function withStampToken<T extends object>(body: T, token: string | null): T | (T & { stampToken: string }) {
  return token ? { ...body, stampToken: token } : body;
}

/**
 * At the save: the stamps the tokens it was sent carry, each checked against this brand's key, its
 * expiry and the kinds this save takes. The key is read once for the save. A refused token is
 * counted by its reason under the first kind, in one write for the save, and left out; nothing
 * is thrown. With every kind's switch off, nothing is read and none come back. At most
 * SAVE_TOKENS_MAX are checked.
 */
export async function stampsFromTokens(
  ctx: TenantContext,
  kinds: readonly LoopKind[],
  tokens: unknown,
  deps: Omit<HandBackDeps, "type"> = {},
): Promise<LoopStamp[]> {
  const on = kinds.filter((k) => countsFor(k));
  if (on.length === 0 || !Array.isArray(tokens) || tokens.length === 0) return [];
  const some = tokens.slice(0, SAVE_TOKENS_MAX);
  const checked = await verifyStamps(ctx, some, deps).catch(() => some.map(() => ({ ok: false as const, reason: "malformed" as const })));
  const out: LoopStamp[] = [];
  const refused = new CountBuffer({ db: deps.db, now: deps.now });
  for (const v of checked) {
    if (v.ok && on.includes(v.stamp.kind)) out.push(v.stamp);
    else refused.unstamped(ctx, on[0]!, `token_${v.ok ? "invalid" : v.reason}`);
  }
  await refused.flush();
  return out;
}
