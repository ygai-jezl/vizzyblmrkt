import type { Evidence, ProductMap } from "./schema";
import type { RepoReader } from "./reader";

/**
 * Check every piece of evidence against the files the model actually read:
 * the path exists and the excerpt really occurs in it (whitespace-insensitive,
 * against the same redacted text the model saw). This is what stops a model from
 * citing code that isn't there. An item keeps its unverified evidence (flagged)
 * so a person can still judge it — review starts it unticked.
 */

const MIN_EXCERPT = 8;

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function verifyEvidence(ev: Evidence, reader: RepoReader): Evidence {
  const excerpt = squash(ev.excerpt);
  if (excerpt.length < MIN_EXCERPT || !reader.has(ev.path)) return { ...ev, verified: false };
  const text = squash(reader.redactedText(ev.path) ?? "");
  // A model may abbreviate with "…": each fragment must appear, in order.
  const parts = excerpt.split(/…|\.\.\./).map((p) => p.trim()).filter((p) => p.length >= 4);
  let from = 0;
  for (const part of parts.length ? parts : [excerpt]) {
    const at = text.indexOf(part, from);
    if (at < 0) return { ...ev, verified: false };
    from = at + part.length;
  }
  return { ...ev, verified: true };
}

export interface VerifyStats {
  items: number;
  verifiedItems: number;
  evidence: number;
  verifiedEvidence: number;
}

/** Verify every item's evidence; returns the map with `verified` set, plus counts. */
export function verifyProductMap(map: ProductMap, reader: RepoReader): { map: ProductMap; stats: VerifyStats } {
  const stats: VerifyStats = { items: 0, verifiedItems: 0, evidence: 0, verifiedEvidence: 0 };
  const check = <T extends { evidence: Evidence[] }>(items: T[]): T[] =>
    items.map((it) => {
      const evidence = it.evidence.map((e) => verifyEvidence(e, reader));
      stats.items += 1;
      stats.evidence += evidence.length;
      const ok = evidence.filter((e) => e.verified).length;
      stats.verifiedEvidence += ok;
      if (ok > 0) stats.verifiedItems += 1;
      return { ...it, evidence };
    });
  return {
    map: {
      ...map,
      onboardingSteps: check(map.onboardingSteps),
      events: check(map.events),
      traits: check(map.traits),
      facts: check(map.facts),
      glossary: check(map.glossary),
      hooks: check(map.hooks),
    },
    stats,
  };
}
