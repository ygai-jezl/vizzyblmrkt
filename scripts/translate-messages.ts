/**
 * Gemini-powered translator for the static i18n catalog.
 *
 * Reads src/lib/i18n/messages/en.json (the English source of truth) and, for each
 * target locale, asks Gemini to translate the VALUES — preserving {{merge_tokens}},
 * {single_brace} placeholders, HTML, and emoji verbatim — then writes
 * src/lib/i18n/messages/<locale>.json. Run this AT AUTHOR TIME (not per request);
 * commit the output so the runtime just reads the file (fast, deterministic, free).
 *
 * Usage:
 *   npx tsx scripts/translate-messages.ts            # default: fr es de ja ar
 *   npx tsx scripts/translate-messages.ts fr ja      # specific locales
 *
 * Needs GOOGLE_GENAI_USE_VERTEXAI + GEMINI_API_KEY (loaded from .env.local).
 * Any key whose required placeholders don't survive translation is DROPPED from
 * the output (so it transparently falls back to English at runtime, never broken).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { LOCALES } from "../src/lib/i18n/locale";
import { DEFAULT_TEXT_MODEL } from "../src/lib/agents/modelConfig";

try {
  process.loadEnvFile(join(process.cwd(), ".env.local"));
} catch {
  // env may already be present in the shell
}

const MESSAGES_DIR = join(process.cwd(), "src/lib/i18n/messages");
// Resolved HERE (after loadEnvFile above), not imported from modelConfig, so a
// GEMINI_TEXT_MODEL set only in .env.local is honored — a module-level import
// would resolve process.env before loadEnvFile runs. The literal default is still
// centralized (imported), so the model id is never duplicated.
const MODEL = process.env.GEMINI_TEXT_MODEL ?? DEFAULT_TEXT_MODEL;

type Catalog = Record<string, string>;

function client(): GoogleGenAI {
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";
  const apiKey = process.env.GEMINI_API_KEY;
  if (useVertex && apiKey) return new GoogleGenAI({ vertexai: true, apiKey });
  if (useVertex) {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    });
  }
  if (apiKey) return new GoogleGenAI({ apiKey });
  throw new Error("Gemini not configured: set GOOGLE_GENAI_USE_VERTEXAI + GEMINI_API_KEY in .env.local");
}

/** Placeholders + HTML tag names that must survive verbatim in a translation. */
function tokensOf(value: string): string[] {
  const merge = value.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [];
  const single = value.match(/(?<!\{)\{[a-zA-Z0-9_]+\}(?!\})/g) ?? [];
  const tags = (value.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).map((t) =>
    (t.match(/^<\/?([a-zA-Z0-9]+)/)?.[1] ?? "").toLowerCase(),
  );
  return [...merge, ...single, ...tags.map((t) => `<${t}>`)].sort();
}

function localeName(code: string): string {
  return LOCALES.find((l) => l.code === code)?.name ?? code;
}

function buildPrompt(name: string, code: string, en: Catalog): string {
  return [
    `You are a professional UI/localization translator. Translate the VALUES of the JSON below from English into ${name} (${code}).`,
    "",
    "STRICT RULES:",
    "- Return ONLY a JSON object with the EXACT SAME KEYS — never add, remove, or rename keys.",
    "- Translate ONLY the human-readable text of each value.",
    "- Reproduce VERBATIM, never translate/alter/reorder-away: any {{double_brace}} tokens (e.g. {{first_name}}, {{referral_link}}), any {single_brace} placeholders (e.g. {count}, {name}, {rank}), any HTML tags/attributes (e.g. <strong>, <a href=\"{{referral_link}}\">), and any emoji.",
    "- These are UI strings: buttons, short labels, and transactional email lines. Keep them concise, natural, and correctly cased for the language; match a friendly product tone.",
    `- Use the correct native script for ${name}. For right-to-left languages return natural text (no added control characters).`,
    "",
    "JSON to translate:",
    JSON.stringify(en),
  ].join("\n");
}

/** Extract the first COMPLETE top-level {…} object, ignoring trailing content and
 *  braces/quotes inside string values (a naive lastIndexOf("}") mis-slices those). */
function extractFirstObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("unterminated JSON object");
}

function parseJson(text: string): Catalog {
  return JSON.parse(extractFirstObject(text)) as Catalog;
}

async function translateLocale(ai: GoogleGenAI, code: string, en: Catalog): Promise<void> {
  const name = localeName(code);
  process.stdout.write(`\n→ ${name} (${code}) … `);
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(name, code, en),
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const raw = res.text;
  if (!raw) throw new Error("empty model response");
  const translated = parseJson(raw);

  const out: Catalog = {};
  const dropped: string[] = [];
  let missingKeys = 0;
  for (const [key, enValue] of Object.entries(en)) {
    const t = translated[key];
    if (typeof t !== "string" || !t.trim()) {
      missingKeys++;
      continue; // falls back to English at runtime
    }
    // Guard: every token/placeholder/HTML tag in the English value must survive.
    if (tokensOf(t).join("|") !== tokensOf(enValue).join("|")) {
      dropped.push(key);
      continue;
    }
    out[key] = t;
  }
  writeFileSync(join(MESSAGES_DIR, `${code}.json`), JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(
    `${Object.keys(out).length}/${Object.keys(en).length} keys` +
      (dropped.length ? ` · dropped (token mismatch → English): ${dropped.join(", ")}` : "") +
      (missingKeys ? ` · ${missingKeys} not returned` : ""),
  );
}

async function main() {
  const locales = process.argv.slice(2);
  const targets = locales.length ? locales : ["fr", "es", "de", "ja", "ar"];
  const en = JSON.parse(readFileSync(join(MESSAGES_DIR, "en.json"), "utf8")) as Catalog;
  const ai = client();
  console.log(`Translating ${Object.keys(en).length} keys → ${targets.join(", ")} (model ${MODEL})`);
  for (const code of targets) {
    if (code === "en") continue;
    if (!LOCALES.some((l) => l.code === code)) {
      console.warn(`\n! skipping unsupported locale "${code}"`);
      continue;
    }
    try {
      await translateLocale(ai, code, en);
    } catch (err) {
      console.error(`\n! ${code} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log("\n\nDone. Review the generated messages/<locale>.json, then wire them into CATALOGS in src/lib/i18n/messages.ts.");
}

void main();
