import { z } from "zod";

/**
 * Vizzy inside Edit mode: what the editor asks for, what the model answers and what the route
 * streams back. Shared by the route and the editor. Pure, client-safe.
 *
 * A request is a selection (the selected text in the stored format, with a little text either
 * side) or the whole piece. The model replies with one short sentence, then a fenced `ops`
 * block: the replacement for a selection, or a few exact-text edits for the whole piece. Nothing
 * is saved: the editor shows each change for the person to keep or undo.
 */

export const VIZZY_LIMITS = {
  INSTRUCTION: 1000,
  SELECTION: 8000,
  /** Text either side of a selection, each way. */
  CONTEXT: 1200,
  MARKDOWN: 20_000,
  EMAIL: 50_000,
  /** Edits in one answer for the whole piece. */
  OPS: 20,
  /** Places one replace_all may change. */
  REPLACE_ALL: 50,
} as const;

const Format = z.enum(["blog", "newsletter", "email"]);

const common = {
  format: Format,
  instruction: z.string().trim().min(1).max(VIZZY_LIMITS.INSTRUCTION),
  /** The workspace a hub belongs to, for its brand voice. Emails have none. */
  workspaceId: z.string().min(1).max(128).optional(),
  /** The merge values this text may use (emails). */
  tokens: z.array(z.string().max(80)).max(80).optional(),
};

const SelectionRequest = z.object({
  ...common,
  mode: z.literal("selection"),
  /** "inline": part of one paragraph, heading, list item or cell. "blocks": whole blocks. */
  shape: z.enum(["inline", "blocks"]),
  selection: z.string().min(1).max(VIZZY_LIMITS.SELECTION),
  before: z.string().max(VIZZY_LIMITS.CONTEXT).default(""),
  after: z.string().max(VIZZY_LIMITS.CONTEXT).default(""),
});

const WholeRequest = z.object({
  ...common,
  mode: z.literal("whole"),
  text: z.string().min(1).max(VIZZY_LIMITS.EMAIL),
});

export const VizzyRequestSchema = z
  .discriminatedUnion("mode", [SelectionRequest, WholeRequest])
  .refine((b) => b.mode !== "whole" || b.format === "email" || b.text.length <= VIZZY_LIMITS.MARKDOWN, {
    message: "text_too_long",
  });
export type VizzyRequest = z.infer<typeof VizzyRequestSchema>;
export type VizzyRequestInput = z.input<typeof VizzyRequestSchema>;

// ── the model's answer ──────────────────────────────────────────────────────────────

const SelectionResultSchema = z.object({
  replacement: z.string().max(12_000),
  note: z.string().max(300).optional(),
});

/** Words only (letters, digits, apostrophes, hyphens, spaces): a spelling-style change. */
const WORDS = /^[\p{L}\p{N}'’ -]*$/u;

export const WholeOpSchema = z.discriminatedUnion("op", [
  /** Exact words in one block, swapped for new ones ("" deletes them). */
  z.object({ op: z.literal("replace"), find: z.string().min(1).max(600), replace: z.string().max(2000) }),
  /** A word or short phrase changed everywhere it appears as a whole word. */
  z.object({
    op: z.literal("replace_all"),
    find: z.string().min(2).max(60).regex(WORDS),
    replace: z.string().max(60).regex(WORDS),
  }),
  /** New blocks after the block holding these exact words. */
  z.object({ op: z.literal("insert_after"), after: z.string().min(2).max(600), insert: z.string().min(1).max(4000) }),
]);
export type WholeOp = z.infer<typeof WholeOpSchema>;

export type VizzyResult =
  | { mode: "selection"; replacement: string; note?: string }
  | { mode: "whole"; ops: WholeOp[]; dropped: number; note?: string };

const BARE = /\{\s*"(?:ops|replacement|note)"/;

/** Where the machine-only part of a reply starts (a ``` fence or a bare JSON object); -1: not yet. */
export function replyBoundary(s: string): number {
  const fence = s.indexOf("```");
  const bare = s.search(BARE);
  if (fence < 0) return bare;
  if (bare < 0) return fence;
  return Math.min(fence, bare);
}

/** The JSON in a reply: from the opening fence to the LAST fence (a replacement may hold a code
 *  fence of its own), or a bare object. */
function jsonText(reply: string): string | null {
  const fence = reply.indexOf("```");
  if (fence >= 0) {
    const lineEnd = reply.indexOf("\n", fence);
    const start = lineEnd >= 0 ? lineEnd + 1 : fence + 3;
    const end = reply.lastIndexOf("```");
    return end > start ? reply.slice(start, end) : reply.slice(start);
  }
  const bare = reply.search(BARE);
  if (bare < 0) return null;
  const end = reply.lastIndexOf("}");
  return end > bare ? reply.slice(bare, end + 1) : null;
}

function parseLoose(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

/** The answer in a model's reply, checked; null when there is none. Bad edits are dropped and
 *  counted, never trusted. */
export function extractVizzyResult(reply: string, mode: "selection" | "whole"): VizzyResult | null {
  const raw = parseLoose(jsonText(reply));
  if (!raw || typeof raw !== "object") return null;
  if (mode === "selection") {
    const r = SelectionResultSchema.safeParse(raw);
    return r.success ? { mode, replacement: r.data.replacement, note: r.data.note } : null;
  }
  const obj = raw as { ops?: unknown; note?: unknown };
  const ops: WholeOp[] = [];
  let dropped = 0;
  for (const item of Array.isArray(obj.ops) ? obj.ops : []) {
    const p = WholeOpSchema.safeParse(item);
    if (p.success && ops.length < VIZZY_LIMITS.OPS) ops.push(p.data);
    else dropped += 1;
  }
  const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim().slice(0, 300) : undefined;
  return { mode, ops, dropped, note };
}

// ── what the route streams ───────────────────────────────────────────────────────────

export interface VizzySuggestedOp {
  op: WholeOp;
  /** Things worth a look, shown beside the change (an AI tell, a dash). */
  warnings: string[];
}

export interface VizzySkipped {
  /** The words the edit was for. */
  excerpt: string;
  reason: string;
}

export type VizzyEvent =
  /** Vizzy's short reply, as it streams (the ops block is never shown). */
  | { type: "text"; text: string }
  | { type: "selection"; replacement: string; warnings: string[] }
  | { type: "whole"; ops: VizzySuggestedOp[]; skipped: VizzySkipped[] }
  | { type: "error"; message: string }
  | { type: "done" };
