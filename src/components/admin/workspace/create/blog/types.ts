import type { BlogBrief } from "@/lib/types/contentPlan";

/**
 * What the canvas hands the inspector for a blog hub written to the CITABLE structure:
 * the plan's brief (the canvas owns it and saves it with the plan), and the two actions
 * that run on the server — research, and the fact check.
 */
export interface BlogHubControls {
  brief: BlogBrief;
  onBriefChange: (next: BlogBrief) => void;
  /** Research the brief: the questions buyers ask, pages to link to, sources to cite. */
  onResearch: () => void;
  /** Check the copy's claims against the brand's own material and the checked sources. */
  onCheckFacts: () => void;
  /** What is running now, if anything. */
  busy: null | "research" | "check";
  /** One line on how the last research or check went ("Found 6 questions…"), or what went wrong. */
  note: string | null;
  /** Which action the note is about, so it is shown beside that action's button. */
  noteFor: "research" | "check";
  /** The article's own URL (the plan's hub URL), when the operator has set one. */
  pageUrl: string | null;
  /** The programme's name — the publisher when the brief names none. */
  brandName: string;
  /** Absolute URL of the brand's primary logo, or null. */
  logoUrl: string | null;
}
