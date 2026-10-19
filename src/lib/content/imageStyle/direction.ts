/**
 * Turn a resolved style into what the image prompt needs. Pure.
 *
 * - An old preset: no direction (the caller uses the preset exactly as today).
 * - A model style: its label and keywords lead the image prompt.
 * - A template style where the template isn't made: its model twin's direction.
 */
import { imageStyleById } from "./catalogue";
import type { ResolvedImageStyle } from "./resolve";

export interface ArtDirection {
  label: string;
  keywords: string;
}

export interface ModelDirection {
  /** What the image is recorded as (a style id, or the old preset id). */
  styleId: string | null;
  /** null = an old preset, used as today. */
  direction: ArtDirection | null;
}

export function modelDirectionFor(resolved: ResolvedImageStyle): ModelDirection {
  if (resolved.engine === "legacy") return { styleId: resolved.presetId, direction: null };
  if (resolved.engine === "model") {
    return { styleId: resolved.id, direction: { label: resolved.label, keywords: resolved.keywords } };
  }
  const twin = imageStyleById(resolved.modelTwin);
  return twin && twin.engine === "model"
    ? { styleId: twin.id, direction: { label: twin.label, keywords: twin.keywords } }
    : { styleId: null, direction: null };
}

/** A brief with the style written in, for prompts that have no style slot of their own. */
export function briefWithDirection(brief: string, direction: ArtDirection | null): string {
  return direction ? `${brief}\n\nVisual style (${direction.label}): ${direction.keywords}.` : brief;
}
