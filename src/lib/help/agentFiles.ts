import { HELP_BODIES } from "@/components/help/bodies";
import { docsOrigin } from "@/lib/developers/flags";
import { docToMarkdown } from "@/lib/developers/markdown";
import { isHelpPagesEnabled } from "./flags";
import { HELP_GROUPS, HELP_PAGES, helpMarkdownPath } from "./pages";

/**
 * What AI assistants read (Vizzy included): each help page as Markdown, an
 * llms.txt index and every page in one file. Built from the same components as
 * the pages, behind the same flag.
 */

export const MARKDOWN = "text/markdown; charset=utf-8";
export const PLAIN = "text/plain; charset=utf-8";

export function helpPageMarkdown(slug: string, origin = docsOrigin()): string | null {
  const render = Object.hasOwn(HELP_BODIES, slug) ? HELP_BODIES[slug] : undefined;
  return render ? docToMarkdown(render(), origin) : null;
}

export function helpLlmsTxt(origin = docsOrigin()): string {
  const lines = [
    "# YouGrow Help",
    "",
    "> How to set up and run YouGrow, in the order it's done: get ready (sending domain, brand, email style), launch a waitlist, grow an audience with content, connect your product, then onboard and retain its users with journeys. Written for the people using YouGrow; developers connecting a product read /developers instead.",
    "",
  ];
  for (const g of HELP_GROUPS) {
    const pages = HELP_PAGES.filter((p) => p.group === g.key);
    if (!pages.length) continue;
    lines.push(`## ${g.label || "Start here"}`);
    for (const p of pages) lines.push(`- [${p.label}](${origin}${helpMarkdownPath(p)}): ${p.summary}`);
    lines.push("");
  }
  lines.push("## Optional", `- [Every page in one file](${origin}/help/llms-full.txt)`, `- [Developer docs](${origin}/llms.txt)`);
  return `${lines.join("\n")}\n`;
}

export function helpLlmsFullTxt(origin = docsOrigin()): string {
  return HELP_PAGES.map((p) => `<!-- ${origin}${p.path} -->\n\n${helpPageMarkdown(p.slug, origin)}`).join("\n---\n\n");
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": PLAIN, "cache-control": "no-store" } });
}

/** The response for a help file: 404 while the help pages are off (or for an unknown name). */
export function helpFile(body: () => string | null, contentType: string): Response {
  const text = isHelpPagesEnabled() ? body() : null;
  if (text === null) return notFound();
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      // For assistants; search engines should index the HTML pages instead.
      "x-robots-tag": "noindex",
    },
  });
}
