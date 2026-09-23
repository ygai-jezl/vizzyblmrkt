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

const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i;
const DOCS_PATH = /(^|\/)(docs?|plans?|examples?|adr|rfcs?)\/|\.(md|mdx|txt|rst|adoc)$/i;

/** What kind of file an excerpt came from — only source code proves something is built. */
export function evidenceKind(path: string): "source" | "docs" | "test" {
  if (TEST_PATH.test(path)) return "test";
  if (DOCS_PATH.test(path)) return "docs";
  return "source";
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function verifyEvidence(ev: Evidence, reader: RepoReader): Evidence {
  const kind = evidenceKind(ev.path);
  const excerpt = squash(ev.excerpt);
  if (excerpt.length < MIN_EXCERPT || !reader.has(ev.path)) return { ...ev, verified: false, kind };
  const text = squash(reader.redactedText(ev.path) ?? "");
  // A model may abbreviate with "…": each fragment must appear, in order.
  const parts = excerpt.split(/…|\.\.\./).map((p) => p.trim()).filter((p) => p.length >= 4);
  let from = 0;
  for (const part of parts.length ? parts : [excerpt]) {
    const at = text.indexOf(part, from);
    if (at < 0) return { ...ev, verified: false, kind };
    from = at + part.length;
  }
  return { ...ev, verified: true, kind };
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
  /** docsCount: whether docs count as proof (glossary terms — not steps, events, facts…). */
  const check = <T extends { evidence: Evidence[] }>(items: T[], docsCount = false): T[] =>
    items.map((it) => {
      const evidence = it.evidence.map((e) => verifyEvidence(e, reader));
      stats.items += 1;
      stats.evidence += evidence.length;
      stats.verifiedEvidence += evidence.filter((e) => e.verified).length;
      if (evidence.some((e) => e.verified && (e.kind === "source" || (docsCount && e.kind === "docs")))) stats.verifiedItems += 1;
      return { ...it, evidence };
    });
  return {
    map: {
      ...map,
      onboardingSteps: check(map.onboardingSteps),
      events: check(map.events),
      traits: check(map.traits),
      facts: check(map.facts),
      glossary: check(map.glossary, true),
      hooks: check(map.hooks),
    },
    stats,
  };
}
