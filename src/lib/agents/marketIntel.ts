import type { Region } from "@/lib/types/tenant";
import { CompanyProfileSchema, type CompanyProfile } from "@/lib/types/company";
import { registrableDomain } from "@/lib/domains/registrableDomain";
import { languageDirective } from "@/lib/i18n/locale";
import { generateGroundedJson } from "./gemini";

/**
 * Market Intelligence Agent (Agent 1) — in-process company enrichment, mirroring
 * Agent 3 (creative.ts): Gemini with Google Search grounding, structured output,
 * graceful degradation. Decoupled (plain inputs/outputs, no Firestore/ctx) so it
 * can later be promoted to an ADK sub-agent or canvas-kind for interactive use.
 *
 * RESIDENCY (§H1): `region` is mandatory. The signer's email (PII) is sent to the
 * US/global Vertex endpoint ONLY for region "us"; for EU/Asia the analysis runs
 * on the registrable domain alone. The worker additionally gates the whole call
 * on the tenant's crmConfig + a daily cap.
 */
export interface EnrichCompanyInput {
  region: Region;
  domain: string;
  sampleEmail?: string | null;
  contextHint?: string | null;
  /**
   * Content language (base code, e.g. "fr") for the narrative fields
   * (`description`, `industry`, …). The JSON KEYS stay English; only the prose
   * values localize. Defaults to English when unset. Independent of `region`.
   */
  language?: string | null;
}

export interface EnrichCompanyResult {
  profile: CompanyProfile | null;
  source: "agent1" | "unavailable";
  model: string | null;
  groundingUsed: boolean;
  reason?: "invalid_domain" | "model_unavailable" | "parse_failed";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function buildPrompt(
  domain: string,
  sampleEmail: string | null,
  hint: string | null,
  language: string | null,
): string {
  const dir = languageDirective(language);
  const lines = [
    `You are a market-intelligence analyst. Research the company that owns the domain "${domain}" and return a single JSON object describing it.`,
    sampleEmail ? `A person signed up using the email "${sampleEmail}".` : "",
    hint ? `Additional context: ${hint}` : "",
    "",
    "Return ONLY minified JSON (no markdown, no prose, no code fences) with these keys:",
    "name, description, industry, employeeRange, estimatedEmployees, hqLocation, country, foundedYear, fundingStage, totalFundingUsd, website, socials{linkedin,twitter,crunchbase}, confidence.",
    "Rules: use ONLY verifiable information from search; set a field to null when unknown — never guess.",
    "All text fields must be PLAIN TEXT (no HTML, no markdown). `description` <= 2 sentences.",
    "`confidence` is your 0-1 confidence in the overall profile.",
    // Localize only the human-readable VALUES; the JSON keys above stay English.
    dir ? `Write the text values in the required language. ${dir}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Remove any HTML tags and collapse whitespace — defence against markup in model output. */
function plain(s: string | null | undefined): string | null {
  if (s == null) return null;
  const stripped = s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return stripped || null;
}

function sanitize(p: CompanyProfile): CompanyProfile {
  return {
    ...p,
    name: plain(p.name),
    description: plain(p.description),
    industry: plain(p.industry),
    hqLocation: plain(p.hqLocation),
    country: plain(p.country),
    fundingStage: plain(p.fundingStage),
  };
}

export async function enrichCompany(input: EnrichCompanyInput): Promise<EnrichCompanyResult> {
  const domain = registrableDomain(input.domain);
  if (!domain) {
    return { profile: null, source: "unavailable", model: null, groundingUsed: false, reason: "invalid_domain" };
  }
  // §H1: only US tenants may send the signer's email to the US/global endpoint.
  const sampleEmail =
    input.region === "us" && input.sampleEmail && EMAIL_RE.test(input.sampleEmail)
      ? input.sampleEmail
      : null;

  const res = await generateGroundedJson(
    buildPrompt(domain, sampleEmail, input.contextHint ?? null, input.language ?? null),
  );
  if (!res) {
    return { profile: null, source: "unavailable", model: null, groundingUsed: false, reason: "model_unavailable" };
  }
  if (res.json == null) {
    return { profile: null, source: "unavailable", model: res.model, groundingUsed: res.groundingUsed, reason: "parse_failed" };
  }
  const parsed = CompanyProfileSchema.safeParse(res.json);
  if (!parsed.success) {
    return { profile: null, source: "unavailable", model: res.model, groundingUsed: res.groundingUsed, reason: "parse_failed" };
  }
  return { profile: sanitize(parsed.data), source: "agent1", model: res.model, groundingUsed: res.groundingUsed };
}
