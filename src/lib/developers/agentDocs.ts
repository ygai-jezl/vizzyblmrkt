import type { ReactNode } from "react";
import DevelopersHome from "@/app/developers/page";
import ConnectYourCodeDocs from "@/app/developers/connect-your-code/page";
import ContextEndpointDocs from "@/app/developers/context-endpoint/page";
import SecurityDocs from "@/app/developers/security/page";
import UsersDocs from "@/app/developers/users/page";
import WebhooksDocs from "@/app/developers/webhooks/page";
import { DOC_PAGES, hasMarkdown, markdownPath } from "./docs";
import { docsOrigin, isDevelopersDocsEnabled } from "./flags";
import { docToMarkdown } from "./markdown";
import { SCHEMAS } from "./schemas";

/**
 * What coding agents read: each docs page as Markdown, an llms.txt index
 * (https://llmstxt.org), every page in one file, and the OpenAPI spec. Behind the
 * same flag as the pages, and built from the same components.
 */

/** Pages with a Markdown twin (the API reference has none — agents read the OpenAPI spec). */
const RENDER: Record<string, () => ReactNode> = {
  "": DevelopersHome,
  "connect-your-code": ConnectYourCodeDocs,
  users: UsersDocs,
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
    "> Lifecycle email driven by what each user does in your product. Your server sends each user's current state to API v2 (HTTP Basic auth); optionally, just before an email, YouGrow asks your context endpoint for live values; and YouGrow sends signed webhooks, such as unsubscribes.",
    "",
    "The contract for an integration is these docs, the OpenAPI spec, the JSON Schemas below and the published `@yougrowai/node` package (0.3.0 and later) — not YouGrow's own source code, which can be ahead of what's deployed. API v1 (`POST /api/v1/events`, HMAC-signed) was removed on 2026-09-25.",
    "",
    "## Docs",
    ...DOC_PAGES.filter(hasMarkdown).map((p) => `- [${p.label}](${origin}${markdownPath(p)}): ${p.summary}`),
    "",
    "## Machine-readable",
    `- [OpenAPI 3.1 spec](${origin}/developers/openapi.json): every endpoint, field, response and error of API v2, and what YouGrow sends you (context requests, webhooks). People browse it at ${origin}/developers/api.`,
    ...Object.entries(SCHEMAS).map(([name, s]) => `- [${s.title} (JSON Schema)](${origin}/developers/schema/${name}): ${s.description}`),
    `- [Test vectors](${origin}/developers/test-vectors.json): reference ES256 tokens as YouGrow signs them, with the public key that verifies them.`,
    `- [Public keys (JWKS)](${origin}/.well-known/jwks.json): verify YouGrow's requests to you.`,
    "",
    "## Optional",
    `- [Every page in one file](${origin}/developers/llms-full.txt)`,
    "- [The Node SDK on npm](https://www.npmjs.com/package/@yougrowai/node)",
  ];
  return `${lines.join("\n")}\n`;
}

export function llmsFullTxt(origin = docsOrigin()): string {
  return DOC_PAGES.filter(hasMarkdown)
    .map((p) => `<!-- ${origin}${p.path} -->\n\n${pageMarkdown(p.slug, origin)}`)
    .join("\n---\n\n");
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": PLAIN, "cache-control": "no-store" } });
}

/** The response for an agent-facing file: 404 while the docs are off (or for an unknown name). */
export function agentFile(body: () => string | null, contentType: string): Response {
  const text = isDevelopersDocsEnabled() ? body() : null;
  if (text === null) return notFound();
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      // For agents; search engines should index the HTML pages instead.
      "x-robots-tag": "noindex",
    },
  });
}

/** A permanent redirect for an agent-facing file that moved (a path on this origin); 404 while the docs are off. */
export function agentRedirect(location: string): Response {
  if (!isDevelopersDocsEnabled()) return notFound();
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "public, max-age=3600", "x-robots-tag": "noindex" },
  });
}
