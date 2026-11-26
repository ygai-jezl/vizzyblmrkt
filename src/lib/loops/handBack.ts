import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { LoopStamp, Made } from "@/lib/types/loopStamp";
import { countMade, countRefusedToken, countsFor } from "./count";
import type { LoopKind } from "./registry";
import { signStamp, verifyStamp } from "./stamp";

/**
 * Outputs handed to the browser and saved later (learning loops step 5, decision 20 and 4.2 of the
 * plan for steps 4 and 5): email assist, Edit mode Vizzy, the brand voice and brand kit drafts,
 * notes extract, Suggest an angle, the email layout and the email images. The route that makes
 * one counts it made once and hands back its stamp as a signed token beside the output; the save
 * route checks the token before it stores what the person saved.
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

/** The most tokens one save checks: each is one HMAC and, once per brand, one key read. */
export const SAVE_TOKENS_MAX = 20;

/**
 * Count a made thing handed to the browser and sign its stamp for the save that follows. Null
 * when it has no stamp, its kind's switch is off, or signing failed (logged; the output still goes).
 */
export async function handBack(ctx: TenantContext, kind: LoopKind, made: Made, deps: HandBackDeps = {}): Promise<string | null> {
  if (!countsFor(kind)) return null;
  await countMade(ctx, kind, made, deps);
  if ("unstamped" in made) return null;
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
 * expiry and the kinds this save takes. A refused token is counted by its reason under the first
 * kind and left out; nothing is thrown. With every kind's switch off, nothing is read and none
 * come back. At most SAVE_TOKENS_MAX are checked.
 */
export async function stampsFromTokens(
  ctx: TenantContext,
  kinds: readonly LoopKind[],
  tokens: unknown,
  deps: Omit<HandBackDeps, "type"> = {},
): Promise<LoopStamp[]> {
  const on = kinds.filter((k) => countsFor(k));
  if (on.length === 0 || !Array.isArray(tokens) || tokens.length === 0) return [];
  const out: LoopStamp[] = [];
  for (const token of tokens.slice(0, SAVE_TOKENS_MAX)) {
    const v = await verifyStamp(ctx, token, deps).catch(() => ({ ok: false as const, reason: "malformed" as const }));
    if (v.ok && on.includes(v.stamp.kind)) out.push(v.stamp);
    else await countRefusedToken(ctx, on[0]!, v.ok ? "invalid" : v.reason, deps);
  }
  return out;
}
