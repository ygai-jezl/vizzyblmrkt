import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import { BRAND_NOTE_LIMITS, BrandNoteKind } from "@/lib/types/brandNote";

/**
 * Notes pulled out of something pasted (a call, a thread, a case study) for a person to tick.
 * One model call, no search; the pasted text is sent to the model and never stored. Nothing
 * is kept until a person adds the ones they want.
 */

export const MAX_PASTE = 30_000;
const MAX_FOUND = 8;

export interface FoundNote {
  kind: BrandNoteKind;
  /** It names a customer, company or person, so it is kept anonymous unless a person says otherwise. */
  namesSomeone: boolean;
  text: string;
}

export function parseFoundNotes(raw: string): FoundNote[] {
  const out: FoundNote[] = [];
  const seen = new Set<string>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**NOTE\**\s*:\**\s*([a-z_ ]+?)\s*\|\s*(yes|no)\s*\|\s*(.+)$/i.exec(line);
    if (!m) continue;
    const kind = BrandNoteKind.safeParse(m[1]!.trim().toLowerCase().replace(/\s+/g, "_"));
    const text = m[3]!.trim().replace(/^["“]|["”]$/g, "").slice(0, BRAND_NOTE_LIMITS.MAX_TEXT);
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!kind.success || text.length < BRAND_NOTE_LIMITS.MIN_TEXT || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind.data, namesSomeone: m[2]!.toLowerCase() === "yes", text });
    if (out.length >= MAX_FOUND) break;
  }
  return out;
}

export async function extractNotes(
  text: string,
  brandName: string,
  deps: { generate?: typeof generateTextWithDeadline } = {},
): Promise<FoundNote[] | null> {
  const raw = await (deps.generate ?? generateTextWithDeadline)(
    renderPrompt("content.brand_notes_extract", {
      brand_name: brandName.replace(/["\n]/g, " ").slice(0, 120) || "the brand",
      text: text.slice(0, MAX_PASTE).replace(/<\/?\s*pasted[^>]*>/gi, " "),
    }),
    { timeoutMs: 50_000, temperature: 0.2, thinkingBudget: 1024 },
  ).catch(() => null);
  if (raw === null) return null;
  return parseFoundNotes(raw);
}
