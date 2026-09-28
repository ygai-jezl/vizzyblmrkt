import { proves, type Evidence, type MapSection, type ProductMap } from "./schema";
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

/**
 * A line that declares a type — an interface, type alias, class, struct or enum —
 * in TypeScript, Python, Go, Rust, Java or Kotlin. It names a shape, not a value.
 */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+)?(?:data\s+)?(?:interface|type|class|struct|enum)\s+[A-Za-z_$][\w$]*/;

export function isDeclaration(excerpt: string): boolean {
  return DECLARATION.test(excerpt.trim());
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
  return { ...ev, verified: true, kind, ...(isDeclaration(ev.excerpt) ? { declaration: true } : {}) };
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
  const check = <T extends { evidence: Evidence[] }>(items: T[], section: MapSection): T[] =>
    items.map((it) => {
      const evidence = it.evidence.map((e) => verifyEvidence(e, reader));
      stats.items += 1;
      stats.evidence += evidence.length;
      stats.verifiedEvidence += evidence.filter((e) => e.verified).length;
      if (evidence.some((e) => proves(e, section))) stats.verifiedItems += 1;
      return { ...it, evidence };
    });
  return {
    map: {
      ...map,
      onboardingSteps: check(map.onboardingSteps, "onboardingSteps"),
      events: check(map.events, "events"),
      traits: check(map.traits, "traits"),
      facts: check(map.facts, "facts"),
      glossary: check(map.glossary, "glossary"),
      hooks: check(map.hooks, "hooks"),
      entityKinds: check(map.entityKinds, "entityKinds"),
    },
    stats,
  };
}
