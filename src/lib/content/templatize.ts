import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateText, generateTextWithImage, parseFirstJson } from "@/lib/agents/gemini";
import {
  isTemplateCategory,
  DEFAULT_TEMPLATE_CATEGORY,
  SEED_TEMPLATE_GROUPS,
} from "@/lib/content/templateCategories";
import { safeFetch, readTextCapped } from "@/lib/security/ssrf";

/**
 * Templatize engine (Agent 3 / Gemini, inline). Assembles a content sample from an
 * Idea Board capture (pasted text + optionally a fetched page + optionally a
 * screenshot image) and asks Gemini for { title, body(with {{tokens}}), category,
 * group }. Degrades to a deterministic fallback when Gemini is unconfigured/errs.
 */

const MAX_SAMPLE_CHARS = 12000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export interface TemplatizeInput {
  text?: string | null;
  url?: string | null;
  fetchable?: boolean | null;
  /** base64 (no data: prefix) + mime for an attached screenshot. */
  screenshot?: { base64: string; mimeType: string } | null;
  /** Workspace's existing structural groups (combobox options) to prefer. */
  knownGroups: string[];
}

export interface TemplatizeResult {
  title: string;
  body: string;
  category: string;
  group: string;
  source: "agent3" | "fallback";
}

/**
 * Best-effort fetch of a public page's readable text. Uses the hardened SSRF fetch
 * (src/lib/security/ssrf.ts): the connected IP is validated at CONNECT time on every
 * redirect hop (DNS-rebinding safe), https is enforced per hop, and the body is read
 * with a hard byte cap (decompression-bomb safe). Returns null on any problem.
 */
async function fetchReadableText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(
      url,
      { headers: { "User-Agent": "Vizzybl-Templatize/1.0", Accept: "text/html,text/plain" } },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 4 },
    );
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    const html = await readTextCapped(res, MAX_FETCH_BYTES);
    return htmlToText(html).slice(0, MAX_SAMPLE_CHARS) || null;
  } catch {
    return null;
  }
}

/** Crude HTML → text: drop script/style, strip tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deriveTitle(text: string): string {
  const first = text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "Captured idea";
  return first.slice(0, 80);
}

function coerce(parsed: unknown): Omit<TemplatizeResult, "source"> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 200) : null;
  const body = typeof o.body === "string" && o.body.trim() ? o.body.trim().slice(0, 10000) : null;
  if (!title || !body) return null;
  const category =
    typeof o.category === "string" && isTemplateCategory(o.category)
      ? o.category
      : DEFAULT_TEMPLATE_CATEGORY;
  const group =
    typeof o.group === "string" && o.group.trim() ? o.group.trim().slice(0, 100) : "Uncategorised";
  return { title, body, category, group };
}

export async function templatizeIdea(input: TemplatizeInput): Promise<TemplatizeResult> {
  const parts: string[] = [];
  if (input.text?.trim()) parts.push(input.text.trim());
  if (input.url && input.fetchable) {
    const fetched = await fetchReadableText(input.url);
    if (fetched) parts.push(fetched);
  } else if (input.url) {
    parts.push(`(Reference link: ${input.url})`);
  }
  const contentSample = parts.join("\n\n").slice(0, MAX_SAMPLE_CHARS).trim();
  const hasImage = Boolean(input.screenshot?.base64);

  if (!contentSample && !hasImage) {
    return { title: "Captured idea", body: "(empty)", category: DEFAULT_TEMPLATE_CATEGORY, group: "Uncategorised", source: "fallback" };
  }

  const prompt = renderPrompt("content.templatize", {
    content_sample: contentSample || "(no text — read the attached screenshot)",
    known_groups: (input.knownGroups.length ? input.knownGroups : SEED_TEMPLATE_GROUPS).join(", "),
  });

  const raw =
    hasImage && input.screenshot
      ? await generateTextWithImage(prompt, input.screenshot.base64, input.screenshot.mimeType)
      : await generateText(prompt);

  const result = raw ? coerce(parseFirstJson(raw)) : null;
  if (result) return { ...result, source: "agent3" };

  // Deterministic fallback so the user always gets a (editable) template.
  const body = contentSample || "(captured from screenshot)";
  return {
    title: deriveTitle(contentSample || "Captured idea"),
    body: body.slice(0, 10000),
    category: DEFAULT_TEMPLATE_CATEGORY,
    group: "Uncategorised",
    source: "fallback",
  };
}
