import type { TemplatePlaceholder, PlaceholderKind } from "@/lib/types/template";

/**
 * Parse + reconcile {{Token}} placeholders. The BODY is authoritative: a template's
 * placeholder list always mirrors the tokens actually present in its body. Pure +
 * client-safe (the UI lazy-derives placeholders for pre-v2 templates).
 */
// Token name capped at 60 chars to match TemplatePlaceholderSchema.token (max 60):
// an over-long {{Token}} simply isn't recognized as a variable (stays literal text)
// rather than producing a placeholder that fails schema validation downstream.
const TOKEN_SRC = "\\{\\{\\s*([A-Za-z0-9_]{1,60})\\s*\\}\\}";

/** Distinct token names, in first-appearance order. */
export function bodyTokens(body: string): string[] {
  const re = new RegExp(TOKEN_SRC, "g");
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = m[1];
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function tokenCounts(body: string): Map<string, number> {
  const re = new RegExp(TOKEN_SRC, "g");
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = m[1];
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

const KINDS: PlaceholderKind[] = ["word", "phrase", "sentence", "paragraph", "list-item"];

function inferKind(token: string): PlaceholderKind {
  const t = token.toLowerCase();
  if (/(list|items?|bullets?)/.test(t)) return "list-item";
  if (/(paragraph|body|story|context|narrative|agitation)/.test(t)) return "paragraph";
  if (/(sentence|line|takeaway|outcome|hook|cta|payoff)/.test(t)) return "sentence";
  if (/(word|name|topic|thing|metric|number)/.test(t)) return "word";
  return "phrase";
}

function humanize(token: string): string {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Reconcile a model-provided placeholder list against the body: keep only tokens
 * present in the body, merge the model's label/hint/kind, and ADD any body token
 * the model missed (inferred). Marks repeatable when a token recurs or the model
 * said so. This guarantees body↔placeholders consistency.
 */
export function reconcilePlaceholders(
  body: string,
  modelPlaceholders: Partial<TemplatePlaceholder>[] = [],
): TemplatePlaceholder[] {
  const counts = tokenCounts(body);
  const byToken = new Map<string, Partial<TemplatePlaceholder>>();
  for (const p of modelPlaceholders) {
    if (p && typeof p.token === "string") byToken.set(p.token, p);
  }
  return [...counts.keys()].map((token) => {
    const m = byToken.get(token) ?? {};
    const kind: PlaceholderKind =
      typeof m.kind === "string" && KINDS.includes(m.kind as PlaceholderKind)
        ? (m.kind as PlaceholderKind)
        : inferKind(token);
    return {
      token,
      label:
        typeof m.label === "string" && m.label.trim()
          ? m.label.trim().slice(0, 80)
          : humanize(token),
      hint: typeof m.hint === "string" && m.hint.trim() ? m.hint.trim().slice(0, 240) : undefined,
      kind,
      repeatable: Boolean(m.repeatable) || (counts.get(token) ?? 0) > 1,
    };
  });
}

/** Model placeholder tokens NOT present in the body (orphans → a validation warning). */
export function orphanPlaceholders(
  body: string,
  modelPlaceholders: Partial<TemplatePlaceholder>[] = [],
): string[] {
  const inBody = new Set(bodyTokens(body));
  const out: string[] = [];
  for (const p of modelPlaceholders) {
    if (p && typeof p.token === "string" && !inBody.has(p.token)) out.push(p.token);
  }
  return out;
}
