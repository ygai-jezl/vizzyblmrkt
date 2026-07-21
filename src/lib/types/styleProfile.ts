import { z } from "zod";

/**
 * A structured aesthetic fingerprint extracted from ONE brand-approved image by a
 * vision pass (see src/lib/content/create/styleProfile.ts). It captures the visual
 * language — NOT the subject — so it can be synthesized across a tenant's exemplars
 * into a reusable "learned brand image style" directive that grounds future
 * generation (Layer 1 of the brand-style feedback loop).
 *
 * Every field is short + capped and defaults to empty, so a sparse/failed extraction
 * still parses. `palette` holds hex codes the model read off the image.
 */
export const StyleProfileSchema = z.object({
  /** Dominant colours as hex (what the model actually saw, not the brand kit). */
  palette: z.array(z.string().max(9)).max(8).default([]),
  /** Lighting character, e.g. "soft diffused daylight, gentle shadows". */
  lighting: z.string().max(200).default(""),
  /** Framing / layout, e.g. "centered subject, generous negative space". */
  composition: z.string().max(200).default(""),
  /** Emotional register, e.g. "calm, optimistic, premium". */
  mood: z.string().max(200).default(""),
  /** How the subject is rendered, e.g. "candid people mid-action, shallow depth". */
  subjectTreatment: z.string().max(200).default(""),
  /** Surface quality, e.g. "matte, fine film grain, low contrast". */
  texture: z.string().max(200).default(""),
  /** Post/finishing, e.g. "muted grade, slight warm tint, no heavy vignette". */
  postProcessing: z.string().max(200).default(""),
  /** Medium, e.g. "photograph" | "flat vector illustration" | "3d render". */
  medium: z.string().max(120).default(""),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;
