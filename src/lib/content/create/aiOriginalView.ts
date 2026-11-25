import { wordDiff, type DiffSegment } from "@/lib/content/wordDiff";
import { editMeasures, sectionChanges, type SectionState } from "@/lib/content/editMeasures";
import type { AiOriginalDoc, EditMeasures, OriginalBy, PairTrigger, WriterSource } from "@/lib/types/aiOriginal";
import type { ContentNode } from "@/lib/types/contentPlan";

/**
 * What the AI draft card and a post's line show (CONTENT_AI_ORIGINALS_ENABLED): who made the AI
 * original and when, the approval it got, and how the copy as it is now differs from it, section
 * by section for Compare. Pure.
 */

export interface DraftSectionView {
  heading: string;
  state: SectionState;
  words: number;
  wordsChanged: number;
  /** The words that turn the AI draft's section into the copy's, for Compare. Empty when the same. */
  segments: DiffSegment[];
}

export interface AiOriginalView {
  at: string;
  by: OriginalBy;
  promptId: string | null;
  sources: WriterSource[];
  regenerations: number;
  /** The last approval of this AI original, or null before one. */
  approval: { at: string; trigger: PairTrigger; measures: EditMeasures } | null;
  /** The copy as it is now, against the AI original. */
  now: EditMeasures;
  sections: DraftSectionView[];
}

const isArticle = (node: Pick<ContentNode, "type" | "channel">) => node.type === "hub" && node.channel === "blog";

export function aiOriginalView(doc: AiOriginalDoc, node: Pick<ContentNode, "type" | "channel" | "body">, nowIso: string): AiOriginalView {
  const original = doc.original;
  const pair = doc.pairs.find((p) => p.original.at === original.at) ?? null;
  const article = isArticle(node);
  const now = editMeasures(original.body, node.body, { originalAt: original.at, approvedAt: nowIso, regenerations: doc.regenerations, sections: article });
  const sections: DraftSectionView[] = article
    ? sectionChanges(original.body, node.body).map((s) => ({
        heading: s.heading,
        state: s.state,
        words: s.words,
        wordsChanged: s.wordsChanged,
        segments: s.state === "same" ? [] : wordDiff(s.before, s.after),
      }))
    : [
        {
          heading: "",
          state: now.approvedAsWritten ? "same" : "changed",
          words: now.words,
          wordsChanged: now.wordsChanged,
          segments: now.approvedAsWritten ? [] : wordDiff(original.body, node.body),
        },
      ];
  return {
    at: original.at,
    by: original.by,
    promptId: original.stamp?.promptId ?? null,
    sources: original.sources,
    regenerations: doc.regenerations,
    approval: pair ? { at: pair.final.at, trigger: pair.trigger, measures: pair.measures } : null,
    now,
    sections,
  };
}
