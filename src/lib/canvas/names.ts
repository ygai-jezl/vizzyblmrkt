/**
 * The names of the canvases Vizzy can fill, in registry order. Pure, with no imports, so the
 * learning registry (src/lib/loops/registry.ts) and client code can name a canvas without pulling
 * in the kind modules, which reach the server.
 *
 * A new canvas adds its name here and its module in src/lib/canvas/registry.ts: typecheck fails
 * until both exist and the module's `kind` matches its name. The Python agent sends the same
 * strings (agents/root_agent/tools), and the canvas route answers 400 for any other.
 */
export const CANVAS_KIND_NAMES = [
  "journey",
  "lifecycle",
  "invite_wave",
  "content_plan",
  "email_style",
  "journey_style",
  "person_plan",
  "brand_map",
  "image_style",
  "person_fields",
  "new_person",
] as const;

export type CanvasKindName = (typeof CANVAS_KIND_NAMES)[number];

/** True for a canvas name this copy knows (never for a name an object inherits, such as toString). */
export function isCanvasKindName(value: unknown): value is CanvasKindName {
  return typeof value === "string" && (CANVAS_KIND_NAMES as readonly string[]).includes(value);
}
