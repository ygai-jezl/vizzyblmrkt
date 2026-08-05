import { z } from "zod";
import { LearnedPatternRuleSchema } from "./tenant";

/**
 * One immutable snapshot of a channel's learned-pattern directive — the audit trail behind the
 * "Content Steering" panel. Every auto-promotion and every revert writes a row, each carrying the
 * transparent LLM-judge rationale ("why the AI is steering your {channel} content this way") and
 * the evidence (which promoted clusters, their support + lift) so an operator can see the reason
 * and course-correct back to any prior version. Lives in `learned_pattern_versions` (regional DB).
 */
export const PatternEvidenceSchema = z.object({
  clusterId: z.string().max(200),
  support: z.number().int().nonnegative(),
  meanLift: z.number(),
  samplePostIds: z.array(z.string().max(200)).max(5).default([]),
});

export const LearnedPatternVersionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  channel: z.string().max(40),
  version: z.number().int().nonnegative(),
  directive: z.string().max(1500).nullable().optional(),
  perform: z.array(LearnedPatternRuleSchema).max(8).default([]),
  avoid: z.array(LearnedPatternRuleSchema).max(6).default([]),
  /** Human-readable explanation of what changed and why (the transparency deliverable). */
  judgeRationale: z.string().max(2000).default(""),
  evidence: z.array(PatternEvidenceSchema).max(12).default([]),
  championScore: z.number().nullable().optional(),
  createdBy: z.enum(["auto", "revert"]).default("auto"),
  createdAt: z.string(),
});
export type PatternEvidence = z.infer<typeof PatternEvidenceSchema>;
export type LearnedPatternVersion = z.infer<typeof LearnedPatternVersionSchema>;

export function patternVersionDocId(tenantId: string, channel: string, version: number): string {
  return `lpv:${encodeURIComponent(tenantId)}:${channel}:${version}`;
}
