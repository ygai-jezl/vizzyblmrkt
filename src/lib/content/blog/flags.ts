/**
 * Flags for the CITABLE blog hub: a blog hub is researched (the questions buyers ask,
 * pages it may link to, sources it may cite), written to a structure answer engines can
 * retrieve and quote, checked against that structure, and handed over with suggested
 * schema markup. Off = a blog hub is written exactly as before. Pure + client-safe.
 */

/** Server flag — research and the CITABLE writer run only when this is on. */
export function isBlogCitableEnabled(): boolean {
  return process.env.CREATE_BLOG_CITABLE_ENABLED === "true";
}

/** Client mirror — the brief, checklist, export and article preview render only when this is on. */
export function isBlogCitableUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BLOG_CITABLE_ENABLED === "true";
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * How much the writer and the fact checker may "think" before answering, in tokens.
 * Thinking is most of each call's time: uncapped, an article takes 55-90 seconds to
 * write; capped here, about 35, to the same structure (measured on the live model). The
 * checker gets more, because finding an unsupported claim is the careful part. Server
 * only; each can be set per environment (BLOG_WRITER_THINKING_BUDGET,
 * BLOG_CHECKER_THINKING_BUDGET).
 */
export function blogWriterThinkingBudget(): number {
  return envInt("BLOG_WRITER_THINKING_BUDGET", 2048);
}

export function blogCheckerThinkingBudget(): number {
  return envInt("BLOG_CHECKER_THINKING_BUDGET", 4096);
}

/** The research searches: the searching is the work, so little thinking is needed —
 *  about 22 seconds a search against 35-45 uncapped (BLOG_RESEARCH_THINKING_BUDGET). */
export function blogResearchThinkingBudget(): number {
  return envInt("BLOG_RESEARCH_THINKING_BUDGET", 1024);
}
