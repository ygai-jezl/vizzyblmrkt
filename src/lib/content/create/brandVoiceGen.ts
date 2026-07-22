import { safeFetch, readTextCapped } from "@/lib/security/ssrf";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { BrandVoiceSchema, type BrandVoice } from "@/lib/types/tenant";
import { htmlToText, stripFenceDelimiters } from "./siteText";

/**
 * AI-generate a structured brand voice grounded in the brand's PRIMARY DOMAIN. Best-effort
 * reads the homepage text (SSRF-hardened via safeFetch — HTTPS-only, DNS-rebinding-safe,
 * byte-capped), fences it as UNTRUSTED, and asks Gemini to infer summary / do's / don'ts /
 * guidelines. Never persists — the caller returns the draft for operator review before save.
 */

// Re-exported for existing importers/tests; the implementation now lives in ./siteText.
export { stripFenceDelimiters };

const FETCH_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 3 * 1024 * 1024;
const MAX_SAMPLE_CHARS = 8000;

/** Fetch + reduce the brand homepage to plain text. Returns null on any failure (fail-soft). */
async function fetchHomepageText(domain: string): Promise<string | null> {
  try {
    const res = await safeFetch(
      `https://${domain}`,
      { headers: { "User-Agent": "Vizzybl-BrandVoice/1.0", Accept: "text/html,text/plain" } },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 4 },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const html = await readTextCapped(res, MAX_FETCH_BYTES);
    return htmlToText(html).slice(0, MAX_SAMPLE_CHARS) || null;
  } catch {
    return null;
  }
}

const clampStr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const clampArr = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim().slice(0, maxLen))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

/**
 * Generate a `BrandVoice` from a domain. Clamps the model output to the schema caps (rather
 * than rejecting overflow) so a slightly-too-long draft still returns something usable. Returns
 * null when the model is unavailable or returns unparseable output.
 */
export async function generateBrandVoiceFromDomain(domain: string): Promise<BrandVoice | null> {
  const siteText = await fetchHomepageText(domain);
  const safeSiteText = siteText ? stripFenceDelimiters(siteText) : null;
  const prompt = renderPrompt("brand.generate_voice", {
    domain,
    site_text: safeSiteText || "(no website text available — infer from the domain name only)",
  });
  const raw = await generateText(prompt);
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const voice: BrandVoice = {
    summary: clampStr(obj.summary, 500),
    dos: clampArr(obj.dos, 12, 300),
    donts: clampArr(obj.donts, 12, 300),
    guidelines: clampStr(obj.guidelines, 2000),
  };
  // Everything with content? If the model returned nothing usable, treat as a failure.
  if (!voice.summary && !voice.guidelines && !voice.dos?.length && !voice.donts?.length) {
    return null;
  }
  return BrandVoiceSchema.parse(voice);
}
