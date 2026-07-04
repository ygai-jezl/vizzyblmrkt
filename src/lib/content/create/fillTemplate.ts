/**
 * Deterministic {{token}} substitution for the Create pillar — fills a template
 * body's placeholders with concrete values (mirrors lib/email/mergeVars.ts but for
 * arbitrary content tokens). Pure + client-safe.
 *
 * The token grammar matches lib/content/placeholders.ts (PascalCase / snake_case,
 * 1–60 chars, whitespace-tolerant braces) so the tokens fillable here are exactly
 * those a template/placeholder list declares. An unknown or unfilled token renders
 * as the empty string (never left as a literal {{...}}), so partially-filled copy
 * never ships brace artifacts.
 *
 * SECURITY: pass `escape` when the result is injected into HTML — ONLY the
 * substituted (model/operator-controlled) value is escaped, never the author's
 * surrounding skeleton, exactly like renderMergeVars.
 */
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]{1,60})\s*\}\}/g;

export function fillTemplate(
  body: string,
  values: Record<string, string>,
  escape?: (s: string) => string,
): string {
  if (!body) return "";
  return body.replace(TOKEN_RE, (_m, token: string) => {
    const raw = Object.prototype.hasOwnProperty.call(values, token) ? values[token] : "";
    const s = raw == null ? "" : String(raw);
    return escape ? escape(s) : s;
  });
}

/**
 * Substitute ONLY the tokens present in `values`, leaving every other {{token}} intact
 * (unlike fillTemplate, which blanks unknowns). Used by the email copywriter so
 * recipient merge vars like {{first_name}} survive verbatim for send-time while the
 * authoritative facts ({{hub_url}}, {{topic}}, …) are baked in. Records what it applied.
 */
export function fillKnownTokens(
  body: string,
  values: Record<string, string>,
  applied?: Record<string, string>,
): string {
  if (!body) return "";
  return body.replace(TOKEN_RE, (m, token: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, token)) return m;
    const v = values[token] == null ? "" : String(values[token]);
    if (applied) applied[token] = v;
    return v;
  });
}

/** Tokens still unfilled (no value, or blank value) after a fill — drives warnings. */
export function unfilledTokens(body: string, values: Record<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(TOKEN_RE.source, "g");
  while ((m = re.exec(body)) !== null) {
    const t = m[1];
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const v = Object.prototype.hasOwnProperty.call(values, t) ? values[t] : "";
    if (!v || !String(v).trim()) out.push(t);
  }
  return out;
}

/**
 * Merge the deterministic dynamic tokens a node always knows (the hub URL + the
 * manual subscriber count) into a value map. Model-provided values take precedence
 * is NOT desired here — these are authoritative strategy facts, so they OVERRIDE
 * any same-named model value (the route, not the model, owns {{hub_url}} etc.).
 */
export function withDynamicTokens(
  values: Record<string, string>,
  dynamic: { hubUrl?: string | null; subscriberCount?: number | null },
): Record<string, string> {
  const merged: Record<string, string> = { ...values };
  if (dynamic.hubUrl != null && dynamic.hubUrl !== "") {
    merged.hub_url = dynamic.hubUrl;
    merged.HubUrl = dynamic.hubUrl;
  }
  if (dynamic.subscriberCount != null) {
    const n = String(dynamic.subscriberCount);
    merged.subscriber_count = n;
    merged.SubscriberCount = n;
  }
  return merged;
}
