import type { ReactNode } from "react";
import DevelopersHome from "@/app/developers/page";
import ConnectYourCodeDocs from "@/app/developers/connect-your-code/page";
import ContextEndpointDocs from "@/app/developers/context-endpoint/page";
import EventsDocs from "@/app/developers/events/page";
import SecurityDocs from "@/app/developers/security/page";
import WebhooksDocs from "@/app/developers/webhooks/page";
import { DOC_PAGES, markdownPath } from "./docs";
import { docsOrigin, isDevelopersDocsEnabled } from "./flags";
import { docToMarkdown } from "./markdown";
import { SCHEMAS } from "./schemas";

/**
 * What coding agents read: each docs page as Markdown, an llms.txt index
 * (https://llmstxt.org) and every page in one file. Behind the same flag as the
 * pages, and built from the same components.
 */

const RENDER: Record<string, () => ReactNode> = {
  "": DevelopersHome,
  "connect-your-code": ConnectYourCodeDocs,
  events: EventsDocs,
  "context-endpoint": ContextEndpointDocs,
  webhooks: WebhooksDocs,
  security: SecurityDocs,
};

export const MARKDOWN = "text/markdown; charset=utf-8";
export const PLAIN = "text/plain; charset=utf-8";
export const JSON_TYPE = "application/json; charset=utf-8";

export function pageMarkdown(slug: string, origin = docsOrigin()): string | null {
  const render = Object.hasOwn(RENDER, slug) ? RENDER[slug] : undefined;
  return render ? docToMarkdown(render(), origin) : null;
}

export function llmsTxt(origin = docsOrigin()): string {
  const lines = [
    "# YouGrow",
    "",
    "> Lifecycle email driven by what each user does in your product. Your server sends signed events; just before an email, YouGrow asks your context endpoint for that user's live state; and YouGrow sends signed webhooks, such as unsubscribes.",
    "",
    "The contract for an integration is these docs, the JSON Schemas below and the published `@yougrowai/node` package — not YouGrow's own source code, which can be ahead of what's deployed.",
    "",
    "## Docs",
    ...DOC_PAGES.map((p) => `- [${p.label}](${origin}${markdownPath(p)}): ${p.summary}`),
    "",
    "## Machine-readable",
    ...Object.entries(SCHEMAS).map(([name, s]) => `- [${s.title} (JSON Schema)](${origin}/developers/schema/${name}): ${s.description}`),
    `- [Signing test vectors](${origin}/developers/test-vectors.json): reference HMAC signatures and ES256 tokens, with the public key that verifies them.`,
    `- [Public keys (JWKS)](${origin}/.well-known/jwks.json): verify YouGrow's requests to you.`,
    "",
    "## Optional",
    `- [Every page in one file](${origin}/developers/llms-full.txt)`,
    "- [The Node SDK on npm](https://www.npmjs.com/package/@yougrowai/node)",
  ];
  return `${lines.join("\n")}\n`;
}

export function llmsFullTxt(origin = docsOrigin()): string {
  return DOC_PAGES.map((p) => `<!-- ${origin}${p.path} -->\n\n${pageMarkdown(p.slug, origin)}`).join("\n---\n\n");
}

/** The response for an agent-facing file: 404 while the docs are off (or for an unknown name). */
export function agentFile(body: () => string | null, contentType: string): Response {
  const text = isDevelopersDocsEnabled() ? body() : null;
  if (text === null) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": PLAIN, "cache-control": "no-store" } });
  }
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      // For agents; search engines should index the HTML pages instead.
      "x-robots-tag": "noindex",
    },
  });
}
