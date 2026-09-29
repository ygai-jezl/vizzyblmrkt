import type { EmailBlock } from "@/lib/types/emailLayout";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { PILL_RADIUS, layoutButtonRadius } from "@/lib/email/emailThemes";

/**
 * A layout button's Colour switch in the editor: Email style (it takes the Email style's button
 * colour and, with a theme other than Classic, its button shape) or Own colour (the colours it was
 * built with).
 * Pure + client-safe. With no `layouts` bit on the style (the flag is off, or no Email style is
 * saved) there's no switch, and the editor works and writes as it always has: no marker.
 */

type ButtonBlock = Extract<EmailBlock, { kind: "button" }>;
export type ButtonColourSource = "email_style" | "own";

/** Where the button's colour comes from, or null with no switch. */
export function buttonColourSource(
  block: Pick<ButtonBlock, "styleSource">,
  style: Pick<ResolvedEmailStyle, "layouts"> | null | undefined,
): ButtonColourSource | null {
  if (!style?.layouts) return null;
  return block.styleSource === "own" ? "own" : "email_style";
}

/**
 * The switch's patch. Email style drops the marker (absent = follows, as for a new button); Own
 * colour sets it. The built colours are never touched, so Own colour gives them back as they were.
 */
export function buttonSourcePatch(source: ButtonColourSource): Pick<Partial<ButtonBlock>, "styleSource"> {
  return { styleSource: source === "own" ? "own" : undefined };
}

/**
 * A colour picker's patch. Where buttons follow the style, touching a picker pins the button to
 * its own colour, so the colour picked is the one it draws; otherwise it's the patch alone.
 */
export function buttonPickerPatch(
  patch: Pick<Partial<ButtonBlock>, "bg" | "color">,
  style: Pick<ResolvedEmailStyle, "layouts"> | null | undefined,
): Pick<Partial<ButtonBlock>, "bg" | "color" | "styleSource"> {
  return style?.layouts ? { ...patch, styleSource: "own" } : patch;
}

/**
 * The theme's button shape, which a following button takes in place of its own corners; null with
 * no theme or Classic (today's look), where it keeps its own and the Corner radius slider shows.
 */
export function themeButtonShape(
  style: Pick<ResolvedEmailStyle, "theme" | "accentColor"> | null | undefined,
): "pill" | "rounded" | "square" | null {
  const radius = layoutButtonRadius(style);
  if (radius === null) return null;
  return radius === PILL_RADIUS ? "pill" : radius ? "rounded" : "square";
}
