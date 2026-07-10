import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { WRITING_RULES } from "@/lib/content/writingRules";
import {
  EmailLayoutSchema,
  MAX_EMAIL_BLOCKS,
  MAX_TEXT_HTML,
  ensureFooterLast,
  type EmailLayout,
  type EmailBlock,
} from "@/lib/types/emailLayout";
import { sanitizeEmailHtml, looksHtml, paragraphize, escapeHtml } from "@/lib/email/emailRender";
import type { BrandKit } from "@/lib/types/tenant";
import { assembleBrandContext } from "./brandContext";

/**
 * Natural-language → email LAYOUT (one Gemini call, Zod-validated) — the same pattern
 * as architectSequence. Returns null on unparseable output so the caller degrades. The
 * result is normalized: fresh ids, block cap, exactly one role:"copy" block seeded with
 * the node's EXISTING copy (so the current AI copy is preserved, not discarded).
 */
export interface GenerateLayoutInput {
  brief: string;
  subject: string;
  /** The email node's current body — injected into the copy block. */
  currentBody: string;
  brandVoice?: string | null;
  audience?: string | null;
  brandKit?: BrandKit | null;
  knowledgeContext?: string;
}

function copyHtmlFrom(body: string): string {
  const raw = !body.trim()
    ? "<p>Your email copy…</p>"
    : looksHtml(body)
      ? sanitizeEmailHtml(body)
      : paragraphize(escapeHtml(body));
  return raw.slice(0, MAX_TEXT_HTML); // a mid-tag cut is re-sanitized safely on render
}

/** Returns a SCHEMA-VALID layout (re-parsed) or null if it can't be made valid. */
function normalize(layout: EmailLayout, currentBody: string): EmailLayout | null {
  // Reserve TWO slots: normalize may add BOTH a synthesized copy block (unshift
  // below) AND the mandatory footer (ensureFooterLast). Reserving one would let a
  // no-text AI layout overflow MAX_EMAIL_BLOCKS and fail re-validation → null.
  const blocks: EmailBlock[] = layout.blocks
    .slice(0, MAX_EMAIL_BLOCKS - 2)
    .map((b) => ({ ...b, id: `${b.kind}_${randomUUID()}` }) as EmailBlock);

  // Pick the copy target: first text block already flagged copy, else the first text block.
  let copyIdx = blocks.findIndex((b) => b.kind === "text" && b.role === "copy");
  if (copyIdx < 0) copyIdx = blocks.findIndex((b) => b.kind === "text");
  if (copyIdx < 0) {
    if (blocks.length >= MAX_EMAIL_BLOCKS) blocks.pop(); // stay within the block cap after unshift
    blocks.unshift({ id: `text_${randomUUID()}`, kind: "text", role: "copy", html: "" } as EmailBlock);
    copyIdx = 0;
  }

  const html = copyHtmlFrom(currentBody);
  const next: EmailBlock[] = blocks.map((b, i) => {
    const cleared = b.role === "copy" ? ({ ...b, role: undefined } as EmailBlock) : b;
    return i === copyIdx ? ({ ...cleared, role: "copy", html } as EmailBlock) : cleared;
  });
  // Guarantee the mandatory footer (exactly one, pinned last) — the AI is only
  // encouraged to add one, so enforce it here. Re-validate so a normalized layout
  // can never fail the graph PUT (silent save error).
  const withFooter = ensureFooterLast({ ...layout, blocks: next });
  const reparsed = EmailLayoutSchema.safeParse(withFooter);
  return reparsed.success ? reparsed.data : null;
}

export async function generateEmailLayout(input: GenerateLayoutInput): Promise<EmailLayout | null> {
  const task = renderPrompt("content.email_layout", {
    brief: input.brief,
    subject: input.subject || "(none)",
    brand_context: assembleBrandContext({
      brandVoice: input.brandVoice,
      audience: input.audience,
      brandKit: input.brandKit,
    }),
    knowledge_context: input.knowledgeContext ?? "",
    max_blocks: MAX_EMAIL_BLOCKS,
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });
  const raw = await generateText(prompt);
  const j = raw ? parseFirstJson(raw) : null;
  if (!j) return null;
  const parsed = EmailLayoutSchema.safeParse(j);
  if (!parsed.success || parsed.data.blocks.length === 0) return null;
  return normalize(parsed.data, input.currentBody);
}
