/**
 * The style one image is made in, for a route: resolved from the image's own pick, the
 * brand's channel style and its default (resolve.ts), with the switch read on the server.
 */
import type { Tenant } from "@/lib/types/tenant";
import { isBrandImageStyleEnabled } from "./flags";
import { resolveImageStyle, type ImageSurface, type ResolvedImageStyle } from "./resolve";
import { modelDirectionFor, type ModelDirection } from "./direction";

export interface ImageStyleChoice {
  enabled: boolean;
  resolved: ResolvedImageStyle;
  /** For the image model: what to record the image as, and the art direction (null = an old preset). */
  model: ModelDirection;
  /** The image's own pick to save with it (null = the brand's). Only meaningful when enabled. */
  ownPick: string | null;
}

export function styleForImage(input: {
  surface: ImageSurface;
  channel?: string | null;
  tenant?: Pick<Tenant, "imageStyle"> | null;
  /** The pick sent with the request: a style id, an old preset id, "brand", or nothing. */
  override?: string | null;
}): ImageStyleChoice {
  const enabled = isBrandImageStyleEnabled();
  const ownPick = input.override && input.override !== "brand" ? input.override : null;
  const resolved = resolveImageStyle({
    enabled,
    surface: input.surface,
    channel: input.channel,
    brand: input.tenant?.imageStyle ?? null,
    override: ownPick,
  });
  return { enabled, resolved, model: modelDirectionFor(resolved), ownPick };
}
