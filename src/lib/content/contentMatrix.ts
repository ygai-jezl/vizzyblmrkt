/**
 * The Content Matrix taxonomy — the fixed 26 TOPICS a creator organises content
 * around (Justin Welsh "Content OS"). Every ingested grounding source must be
 * assigned ONE topic (required at ingest); custom free-form `tags` are separate.
 * Both are queryable (retrieval can pre-filter by topic or tag).
 *
 * Source: the operator's Content Matrix (26 topics, alphabetical). The N→W topics
 * (networking … writing) are verbatim from the provided matrix; the A→M topics
 * were not visible in the crop and use the standard set — CONFIRM/adjust here as
 * needed (this file is the single source of truth for the validator + UI picker).
 */
export interface ContentMatrixTopic {
  /** Stable id stored on tickets/chunks (kebab-case). */
  id: string;
  label: string;
}

export const CONTENT_MATRIX_TOPICS: ContentMatrixTopic[] = [
  // A–M (standard set — confirm against the matrix)
  { id: "audience", label: "Audience" },
  { id: "beliefs", label: "Beliefs" },
  { id: "confidence", label: "Confidence" },
  { id: "education", label: "Education" },
  { id: "email", label: "Email" },
  { id: "failure", label: "Failure" },
  { id: "focus", label: "Focus" },
  { id: "habits", label: "Habits" },
  { id: "leadership", label: "Leadership" },
  { id: "money", label: "Money" },
  // N–W (verbatim from the provided Content Matrix)
  { id: "networking", label: "Networking" },
  { id: "opportunity", label: "Opportunity" },
  { id: "promotion", label: "Promotion" },
  { id: "publishing", label: "Publishing" },
  { id: "risk", label: "Risk" },
  { id: "sales", label: "Sales" },
  { id: "self-promotion", label: "Self-promotion" },
  { id: "sharing", label: "Sharing" },
  { id: "social-media", label: "Social Media" },
  { id: "solopreneurship", label: "Solopreneurship" },
  { id: "success", label: "Success" },
  { id: "systems", label: "Systems" },
  { id: "thinking", label: "Thinking" },
  { id: "time", label: "Time" },
  { id: "work-ethic", label: "Work Ethic" },
  { id: "writing", label: "Writing" },
];

const TOPIC_IDS = new Set(CONTENT_MATRIX_TOPICS.map((t) => t.id));

export function isContentMatrixTopic(id: string): boolean {
  return TOPIC_IDS.has(id);
}

export function contentMatrixLabel(id: string): string {
  return CONTENT_MATRIX_TOPICS.find((t) => t.id === id)?.label ?? id;
}
