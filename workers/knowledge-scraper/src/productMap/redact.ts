/**
 * Strip credentials from repo text BEFORE it reaches the model or is stored as
 * evidence. A customer's repo can contain keys committed by mistake; we never
 * want them in a prompt, a log or a product map. Patterns are deliberately broad:
 * a false positive only hides a harmless string from the analysis.
 */

const REDACTED = "«redacted»";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\b[0-9a-f]{32}-us\d{1,2}\b/g, // Mailchimp Marketing
  /\bygs_[A-Za-z0-9_-]{20,}\b/g, // YouGrow connection secrets
  /\bvzbl_live_[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
];

/** `apiKey: "…"`, `SECRET = '…'`, `password="…"` — keep the name, hide the value. */
const ASSIGNMENT =
  /((?:secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|token)["']?\s*[:=]\s*)(["'`])([^"'`\n]{8,})\2/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNMENT, (_m, lhs: string, q: string, value: string) =>
    // Leave obvious non-secrets readable: env lookups and placeholders.
    /^(process\.env|import\.meta\.env|\$\{|<|your[_-]|xxx|changeme|example)/i.test(value) ? `${lhs}${q}${value}${q}` : `${lhs}${q}${REDACTED}${q}`,
  );
  return out;
}

export const __test = { REDACTED };
