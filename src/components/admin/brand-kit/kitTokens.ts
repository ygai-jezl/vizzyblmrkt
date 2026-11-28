import type { PaletteColor, PaletteGroup } from "@/lib/types/tenant";

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
 * What a token stamps in the kit: the palette group Keep as palette made from its colours (`groupId`),
 * or the colours it added to the Colour palette (`hexes`, as six digit hex in lower case).
 */
export type TokenHolds = { groupId: string } | { hexes: string[] };

/** A token and what it stamps. */
export type KitToken = { token: string } & TokenHolds;

/**
 * The tokens Account › Brand and Brand Kit › Colours send with their next save. A guidelines PDF's
 * extract sends none: its route stores the kit and counts it kept there, so only colours kept from
 * a source wait here.
 */
export interface KitTokens {
  /** The tokens of colours kept from a source since the kit was last saved or replaced, each with what it stamps. */
  colours: KitToken[];
}

export const NO_KIT_TOKENS: KitTokens = { colours: [] };

/**
 * The kit was replaced (an extract, or the stored kit loading): colours kept from a source before
 * are no longer in the kit, so their tokens go.
 */
export function kitReplaced(): KitTokens {
  return { colours: [] };
}

const hexOf = (hex: string) => hex.trim().toLowerCase();

/**
 * Colours from a source went into the kit: their group's token goes with the next save, once, with
 * what it stamps. The same token handed up again (more of its colours added) adds those colours.
 */
export function withColourToken(t: KitTokens, token: string, holds: TokenHolds): KitTokens {
  const held: TokenHolds = "hexes" in holds ? { hexes: [...new Set(holds.hexes.map(hexOf))] } : holds;
  const at = t.colours.findIndex((k) => k.token === token);
  if (at < 0) return { ...t, colours: [...t.colours, { token, ...held }] };
  const cur = t.colours[at]!;
  if (!("hexes" in cur) || !("hexes" in held)) return t;
  const next = { token, hexes: [...new Set([...cur.hexes, ...held.hexes])] };
  return { ...t, colours: t.colours.map((k, i) => (i === at ? next : k)) };
}

/**
 * The tokens the next save sends: only those whose colours are still in what it saves, so a
 * palette group removed, or colours taken back out of the Colour palette, send nothing. A kept
 * group is still there while a group with its id holds a colour. After the save, the page starts
 * again from NO_KIT_TOKENS.
 */
export function kitTokensToSend(t: KitTokens, kit: { palette?: readonly PaletteColor[] | null; palettes?: readonly PaletteGroup[] | null }): string[] {
  const inPalette = new Set((kit.palette ?? []).map((c) => hexOf(c.hex)));
  const groups = new Set((kit.palettes ?? []).filter((g) => g.colors.length > 0).map((g) => g.id));
  return t.colours.filter((k) => ("groupId" in k ? groups.has(k.groupId) : k.hexes.some((h) => inPalette.has(h)))).map((k) => k.token);
}
