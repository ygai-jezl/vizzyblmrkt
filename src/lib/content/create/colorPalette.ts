import type { PaletteColor } from "@/lib/types/tenant";

/**
 * Pure, client-safe colour helpers for the Brand Kit Colours card (no server imports, so
 * both the client editor and the server extraction routes can share them). Everything a
 * hex touches — model output, harvested CSS tokens, operator input — is funnelled through
 * `normalizeHex` so only canonical `#rrggbb` reaches the palette or the schema.
 */

/** The one canonical 6-digit hex matcher (previously duplicated in brandContext + BrandSettings). */
export const HEX6 = /^#[0-9a-f]{6}$/;

/**
 * Coerce a colour token to canonical lowercase `#rrggbb`, or null if it isn't a colour.
 * Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (alpha dropped), and `rgb()/rgba()`
 * (numeric or percentage channels, comma or space separated). Named colours are NOT
 * resolved (returns null) — the AI curation step handles anything textual.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();

  const hex = /^#?([0-9a-f]+)$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      // #rgb / #rgba → expand the RGB nibbles, drop any alpha.
      h = h
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("");
    } else if (h.length === 6 || h.length === 8) {
      h = h.slice(0, 6); // drop an 8-digit's alpha
    } else {
      return null; // 1,2,5,7,9+ digits → not a colour
    }
    return `#${h}`;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((p) => {
      const n = p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p);
      return Math.round(n);
    });
    if (channels.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return `#${channels.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  return null;
}

/**
 * Harvest candidate colour tokens (hex + rgb/rgba) from raw HTML — inline `style="…"`
 * attributes and `<style>` blocks — normalized + deduped, capped. The website analogue of
 * `layoutPaletteHexes`. Over-harvests slightly (e.g. an `#id` selector that is coincidentally
 * valid hex); the AI curation step discards non-brand noise, so favour recall here.
 */
export function harvestCssColors(html: string, cap = 200): string[] {
  const out = new Set<string>();
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{1,80}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const norm = normalizeHex(m[0]);
    if (norm) out.add(norm);
    if (out.size >= cap) break;
  }
  return [...out];
}

/**
 * Merge `additions` into `existing`, deduping case-insensitively by normalized hex (first
 * occurrence wins its name/role) and hard-capping the result. Returns the merged list plus
 * the count of colours that were dropped (invalid hex, duplicate, or over the cap) so the UI
 * can report "palette full".
 */
export function mergeColors(
  existing: PaletteColor[],
  additions: PaletteColor[],
  max = 24,
): { merged: PaletteColor[]; skipped: number } {
  const merged: PaletteColor[] = existing.map((c) => ({ ...c }));
  const seen = new Set(
    existing.map((c) => normalizeHex(c.hex)).filter((h): h is string => Boolean(h)),
  );
  let skipped = 0;
  for (const add of additions) {
    const hex = normalizeHex(add.hex);
    if (!hex) {
      skipped += 1;
      continue;
    }
    if (seen.has(hex)) continue; // duplicate — silently absorbed, not "skipped"
    if (merged.length >= max) {
      skipped += 1;
      continue;
    }
    seen.add(hex);
    merged.push({ ...add, hex });
  }
  return { merged, skipped };
}

/**
 * Validate + normalize a raw model `palette` array into `PaletteColor[]`: drop anything whose
 * hex won't normalize, dedupe by hex, clamp name/role lengths, and coerce `estimated` (forced
 * on for image sources — favicon/logo — where every hex is pixel-estimated). Caps at 48.
 */
export function clampColors(raw: unknown, opts: { forceEstimated?: boolean } = {}): PaletteColor[] {
  if (!Array.isArray(raw)) return [];
  const out: PaletteColor[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const hex = normalizeHex(typeof o.hex === "string" ? o.hex : null);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const color: PaletteColor = { hex };
    if (typeof o.name === "string" && o.name.trim()) color.name = o.name.trim().slice(0, 60);
    if (typeof o.role === "string" && o.role.trim()) color.role = o.role.trim().slice(0, 40);
    if (opts.forceEstimated || o.estimated === true) color.estimated = true;
    out.push(color);
    if (out.length >= 48) break;
  }
  return out;
}
