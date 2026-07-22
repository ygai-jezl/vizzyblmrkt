import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { clampColors, normalizeHex } from "./colorPalette";
import type { PaletteColor } from "@/lib/types/tenant";

/**
 * Generate a cohesive brand colour THEME (pure model call — no fetch/file). "expand" keeps the
 * seed colours and completes the set with harmonious complements + neutrals; "fresh" designs a
 * new palette grounded in the brand summary/voice/domain. The route seeds this WEBSITE-first
 * (see colors/theme). Fail-soft: null on unavailable model / unparseable output.
 */
export interface ColorThemeInput {
  seed?: PaletteColor[];
  mode?: "expand" | "fresh";
  brandSummary?: string | null;
  brandVoice?: string | null;
  domain?: string | null;
  tenantName?: string | null;
}

export async function generateColorTheme(input: ColorThemeInput): Promise<PaletteColor[] | null> {
  const seedColors = (input.seed ?? [])
    .map((c) => normalizeHex(c.hex))
    .filter((h): h is string => Boolean(h));
  const mode = input.mode ?? (seedColors.length ? "expand" : "fresh");
  const prompt = renderPrompt("brand.generate_theme", {
    mode,
    seed_colors: seedColors.join(", ") || "(none)",
    brand_summary: input.brandSummary?.trim().slice(0, 1000) || "(none)",
    brand_voice: input.brandVoice?.trim().slice(0, 1000) || "(none)",
    domain: input.domain?.trim() || "(none)",
    tenant_name: input.tenantName?.trim() || "(none)",
  });
  const raw = await generateText(prompt);
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object") return null;
  const colors = clampColors((json as Record<string, unknown>).palette);
  return colors.length ? colors : null;
}
