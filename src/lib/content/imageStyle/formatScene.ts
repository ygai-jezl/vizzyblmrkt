import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateImageWithDeadline, generateTextWithDeadline, type GeneratedImage } from "@/lib/agents/gemini";
import { resolveImageModel } from "@/lib/agents/modelConfig";
import type { FormatInputs, ImageFormatId } from "@/lib/types/imageStyle";

/**
 * The painted scene inside a format (IMAGE_FORMATS_ENABLED): Nano Banana 2 paints a place, an
 * object or a metaphor for what the card says, in the image's style. Never a person (the card
 * names a real one in type) and never a logo (the partner is named in type). Null when there's
 * no time or the model fails; the format is then drawn from type alone.
 */

const LABEL: Record<Exclude<ImageFormatId, "standard">, string> = {
  portrait: "quote card (a person's words, with their name in type beside the picture)",
  partner: "partnership card (two company names in type over the picture)",
  report_cover: "report cover",
};
const HINT: Record<Exclude<ImageFormatId, "standard">, string> = {
  portrait: "a setting that fits the subject of the quote (a desk, a workshop, a landscape, an object that stands for the idea).",
  partner: "two things that work together or connect (paths that meet, parts that fit, a bridge), soft enough to sit behind type.",
  report_cover: "the subject of the report as one striking still life or scene.",
};

export interface SceneRequest {
  format: Exclude<ImageFormatId, "standard">;
  inputs: FormatInputs;
  /** The headline or title the card carries. */
  headline: string;
  direction: { label: string; keywords: string };
  brandContext?: string;
  /** "1:1", "4:5" → "3:4", "16:9". */
  aspectRatio: string;
  timeoutMs: number;
}

export interface SceneDeps {
  brief: (prompt: string, timeoutMs: number) => Promise<string | null>;
  paint: (prompt: string, aspectRatio: string, timeoutMs: number) => Promise<GeneratedImage | null>;
}

const defaultDeps: SceneDeps = {
  brief: (prompt, timeoutMs) => generateTextWithDeadline(prompt, { timeoutMs }),
  paint: (prompt, aspectRatio, timeoutMs) => generateImageWithDeadline({ prompt, aspectRatio, model: resolveImageModel("full"), timeoutMs }),
};

/** What the card says, as the topic for its scene. */
export function sceneWords(req: Pick<SceneRequest, "format" | "inputs" | "headline">): string {
  const f = req.inputs;
  if (req.format === "portrait") return (f.quote || req.headline).slice(0, 300);
  if (req.format === "partner") return [f.line || req.headline].join(" ").slice(0, 300);
  return [f.title || req.headline, f.subtitle].filter(Boolean).join(". ").slice(0, 300);
}

export async function paintFormatScene(req: SceneRequest, deps: SceneDeps = defaultDeps): Promise<GeneratedImage | null> {
  if (req.timeoutMs < 12_000) return null;
  const started = Date.now();
  const prompt =
    (await deps
      .brief(
        renderPrompt("content.format_scene_brief", {
          format_label: LABEL[req.format],
          words: sceneWords(req),
          style_label: req.direction.label,
          style_keywords: req.direction.keywords,
          brand_context: req.brandContext ?? "",
          scene_hint: HINT[req.format],
        }),
        Math.min(12_000, req.timeoutMs / 3),
      )
      .catch(() => null))?.trim() ||
    `${HINT[req.format]} Visual style: ${req.direction.keywords}. No people, no logos, no text.`;
  const left = req.timeoutMs - (Date.now() - started);
  if (left < 12_000) return null;
  return deps.paint(prompt, req.aspectRatio, Math.min(40_000, left)).catch(() => null);
}
