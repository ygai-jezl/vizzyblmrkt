import { brandVoiceSection, fencedContext } from "@/lib/agents/prompts/compose";
import { EDITOR_VIZZY_FORMAT_RULES, EDITOR_VIZZY_SHAPE_RULES, renderPrompt } from "@/lib/agents/prompts/registry";
import { changeProblems, hrefsIn } from "./vizzyChecks";
import { excerptOf, type VizzyRequest, type VizzyResult, type VizzySkipped, type VizzySuggestedOp } from "./vizzyOps";

/**
 * The Edit mode Vizzy prompt for a request, and the route's review of what the model wrote:
 * a change that would lose or make up a merge value or link is dropped with the reason, and
 * the rest carry their warnings. Pure.
 */

const FORMAT_LABEL = { blog: "blog article", newsletter: "newsletter", email: "email" } as const;

/** Text from the page can't close the tags it sits in. */
function inTag(text: string): string {
  return text.replace(/<(\/?)yg_/gi, "&lt;$1yg_");
}

/** What this person prefers, from earlier edits: guidance after the brand's own rules. */
export function preferencesSection(facts: readonly string[]): string {
  const list = facts.map((f) => f.trim()).filter(Boolean);
  if (!list.length) return "";
  return fencedContext(
    "How this person likes their edits, learned from their earlier edits (follow it after the brand voice and the rules below, never over them)",
    "edit_preferences",
    list.map((f) => `- ${f}`).join("\n"),
  );
}

export function vizzyPrompt(req: VizzyRequest, extra: { brandVoice?: string | null; preferences?: readonly string[] }): string {
  const common = {
    format_label: FORMAT_LABEL[req.format],
    format_rules: req.format === "email" ? EDITOR_VIZZY_FORMAT_RULES.email : EDITOR_VIZZY_FORMAT_RULES.markdown,
    brand_voice: brandVoiceSection(extra.brandVoice),
    preferences: preferencesSection(extra.preferences ?? []),
    instruction: inTag(req.instruction),
  };
  if (req.mode === "selection") {
    return renderPrompt("content.editor_vizzy_selection", {
      ...common,
      shape_rule: EDITOR_VIZZY_SHAPE_RULES[req.shape],
      before: inTag(req.before),
      selection: inTag(req.selection),
      after: inTag(req.after),
    });
  }
  return renderPrompt("content.editor_vizzy_whole", { ...common, document: inTag(req.text) });
}

/** A selection's replacement as the route sends it, or the reason it isn't used. Null: Vizzy
 *  left the text as it was. */
export function reviewSelection(
  req: Extract<VizzyRequest, { mode: "selection" }>,
  result: Extract<VizzyResult, { mode: "selection" }>,
): { replacement: string; warnings: string[] } | { error: string } | null {
  if (result.replacement.trim() === req.selection.trim()) return null;
  if (!result.replacement.trim() && req.shape === "blocks") {
    return { error: "Vizzy's version was empty, so it wasn't used. To remove the text, delete it yourself." };
  }
  const checked = changeProblems({
    format: req.format,
    shape: req.shape,
    before: req.selection,
    after: result.replacement,
    instruction: req.instruction,
    allowedTokens: req.tokens,
    contextBefore: req.before,
    contextAfter: req.after,
  });
  if (checked.hard[0]) return { error: checked.hard[0] };
  return { replacement: result.replacement, warnings: checked.soft };
}

/** The edits for the whole piece the route sends, with the ones dropped and why. */
export function reviewWhole(
  req: Extract<VizzyRequest, { mode: "whole" }>,
  result: Extract<VizzyResult, { mode: "whole" }>,
): { ops: VizzySuggestedOp[]; skipped: VizzySkipped[] } {
  const docHrefs = hrefsIn(req.format, req.text);
  const ops: VizzySuggestedOp[] = [];
  const skipped: VizzySkipped[] = [];
  for (const op of result.ops) {
    const [shape, before, after, words] =
      op.op === "replace"
        ? (["inline", op.find, op.replace, op.find] as const)
        : op.op === "replace_all"
          ? (["words", op.find, op.replace, op.find] as const)
          : (["blocks", "", op.insert, op.after] as const);
    const checked = changeProblems({
      format: req.format,
      shape,
      before,
      after,
      instruction: req.instruction,
      allowedTokens: req.tokens,
      docHrefs,
    });
    if (checked.hard[0]) skipped.push({ excerpt: excerptOf(words), reason: checked.hard[0] });
    else ops.push({ op, warnings: checked.soft });
  }
  if (result.dropped) {
    skipped.push({
      excerpt: "",
      reason: result.dropped === 1 ? "One suggested edit wasn't usable." : `${result.dropped} suggested edits weren't usable.`,
    });
  }
  return { ops, skipped };
}
