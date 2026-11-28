/**
 * Which stamp tokens a brand kit save sends (learning loops step 5, decision 20). A save counts
 * kept once for each stamp it is sent, so each token goes with at most one save, and only while
 * what it stamps is still in what the save holds. Client safe: no server code here.
 */

/** A tray group of colours from one source, with the token of what made them. */
export interface TokenGroup {
  stampToken?: string;
}

/**
 * A tray group's token goes up once, the first time any of its colours are kept: the group keeps
 * its colours and loses the token, so a later click from it can't send it with another save. A
 * group whose token has changed since (the source was run again) keeps its new one.
 */
export function handUpGroupToken<G extends TokenGroup>(group: G, token: string): G {
  if (group.stampToken !== token) return group;
  const next = { ...group };
  delete next.stampToken;
  return next;
}

/**
 * The tokens Account › Brand sends with its next save. A guidelines PDF's extract sends none: its
 * route stores the kit and counts it kept there, so only colours kept from a source wait here.
 */
export interface KitTokens {
  /** The tokens of colours kept from a source since the kit was last saved or replaced. */
  colours: string[];
}

export const NO_KIT_TOKENS: KitTokens = { colours: [] };

/**
 * The kit was replaced (an extract, or the stored kit loading): colours kept from a source before
 * are no longer in the kit, so their tokens go.
 */
export function kitReplaced(): KitTokens {
  return { colours: [] };
}

/** Colours from a source went into the kit: their group's token goes with the next save, once. */
export function withColourToken(t: KitTokens, token: string): KitTokens {
  return t.colours.includes(token) ? t : { ...t, colours: [...t.colours, token] };
}

/** The tokens the next save sends. After it saves, the page starts again from NO_KIT_TOKENS. */
export function kitTokensToSend(t: KitTokens): string[] {
  return [...t.colours];
}
