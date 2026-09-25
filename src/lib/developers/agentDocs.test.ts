import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { H2 } from "@/components/developers/Doc";
import DevelopersHome from "@/app/developers/page";
import ConnectYourCodeDocs from "@/app/developers/connect-your-code/page";
import ContextEndpointDocs from "@/app/developers/context-endpoint/page";
import EventsDocs from "@/app/developers/events/page";
import SecurityDocs from "@/app/developers/security/page";
import WebhooksDocs from "@/app/developers/webhooks/page";
import vectors from "../../../sdk/node/test/vectors.json";
import { agentFile, llmsFullTxt, llmsTxt, MARKDOWN, pageMarkdown } from "./agentDocs";
import { DOC_PAGES } from "./docs";
import { docsOrigin } from "./flags";
import { jsonSchema, SCHEMAS } from "./schemas";

const ORIGIN = "https://yougrow.test";
const PAGES: Record<string, () => ReactNode> = {
  "": DevelopersHome,
  "connect-your-code": ConnectYourCodeDocs,
  events: EventsDocs,
  "context-endpoint": ContextEndpointDocs,
  webhooks: WebhooksDocs,
  security: SecurityDocs,
};

type El = { type: unknown; props: { children?: ReactNode } & Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "type" in n && "props" in n;

/** The text of every H2 in a page's element tree — what the HTML page shows. */
function h2s(node: ReactNode): string[] {
  const text = (n: ReactNode): string =>
    Array.isArray(n) ? n.map(text).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isEl(n) ? text(n.props.children) : "";
  const out: string[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isEl(n)) return;
    if (n.type === H2) out.push(text(n.props.children).trim());
    walk(n.props.children);
    if (Array.isArray(n.props.rows)) walk(n.props.rows as ReactNode);
  };
  walk(node);
  return out;
}

describe("docs as Markdown", () => {
  it("has a Markdown twin for every docs page, with the same sections", () => {
    expect(DOC_PAGES.map((p) => p.slug).sort()).toEqual(Object.keys(PAGES).sort());
    for (const page of DOC_PAGES) {
      const md = pageMarkdown(page.slug, ORIGIN)!;
      const sections = h2s(PAGES[page.slug]!());
      expect(sections.length, page.path).toBeGreaterThan(0);
      expect(md, page.path).toMatch(/^# \S/);
      for (const s of sections) expect(md, `${page.path}: ${s}`).toContain(`\n## ${s}\n`);
      expect(md, page.path).not.toMatch(/\[object Object\]|undefined|NaN/);
    }
  });

  it("turns links into absolute URLs, and docs links into their .md twins", () => {
    const md = pageMarkdown("", ORIGIN)!;
    expect(md).toContain(`(${ORIGIN}/developers/events.md)`);
    expect(md).toContain(`(${ORIGIN}/developers/connect-your-code.md)`);
    expect(md).toContain("(https://www.npmjs.com/package/@yougrowai/node)");
    expect(md).not.toMatch(/\]\(\//); // no relative links left
  });

  it("keeps code blocks, inline code and field tables", () => {
    const md = pageMarkdown("events", ORIGIN)!;
    expect(md).toContain("**yougrow.ts**\n```\nimport { createHmac, randomUUID }");
    expect(md).toContain(`const URL = "${docsOrigin()}/api/v1/events";`); // code samples show this environment's origin
    expect(md).toContain("| Field | Type | Notes |");
    expect(md).toMatch(/\| `messageId` \| `string` \| Unique per message/);
    expect(md).toContain("`user.signed_up`");
    const security = pageMarkdown("security", ORIGIN)!;
    expect(security).toContain("> **Important:** Verify against the **raw** body.");
  });

  it("returns null for a page that doesn't exist", () => {
    expect(pageMarkdown("nope", ORIGIN)).toBeNull();
    expect(pageMarkdown("constructor", ORIGIN)).toBeNull();
  });
});

describe("llms.txt and llms-full.txt", () => {
  it("indexes every page, schema and the test vectors", () => {
    const txt = llmsTxt(ORIGIN);
    expect(txt).toMatch(/^# YouGrow\n\n> /);
    for (const p of DOC_PAGES) expect(txt).toContain(`](${ORIGIN}${p.path}.md): `);
    for (const name of Object.keys(SCHEMAS)) expect(txt).toContain(`(${ORIGIN}/developers/schema/${name})`);
    expect(txt).toContain(`(${ORIGIN}/developers/test-vectors.json)`);
    expect(txt).toContain(`(${ORIGIN}/developers/llms-full.txt)`);
  });

  it("puts every page in one file, in reading order", () => {
    const full = llmsFullTxt(ORIGIN);
    const at = DOC_PAGES.map((p) => full.indexOf(`<!-- ${ORIGIN}${p.path} -->`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("JSON Schemas", () => {
  it("publishes each protocol message, generated from the API's validators", () => {
    for (const name of Object.keys(SCHEMAS)) {
      const s = jsonSchema(name, ORIGIN)!;
      expect(s).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${ORIGIN}/developers/schema/${name}`, type: "object" });
    }
    const events = jsonSchema("events.json", ORIGIN) as { properties: { batch: { maxItems: number; items: { oneOf: unknown[] } } } };
    expect(events.properties.batch.maxItems).toBe(100);
    expect(events.properties.batch.items.oneOf).toHaveLength(2);
    const response = jsonSchema("context-response.json", ORIGIN) as { required?: string[] };
    expect(response.required).toEqual(["asOf"]); // what a customer sends: defaults are optional
    expect(jsonSchema("nope.json", ORIGIN)).toBeNull();
    expect(jsonSchema("toString", ORIGIN)).toBeNull();
  });

  it("serves the same test vectors the SDK pins", () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
    expect(vectors.outbound.tokens.length).toBeGreaterThan(0);
  });
});

describe("agent files follow the docs flag", () => {
  const before = process.env.DEVELOPERS_DOCS_ENABLED;
  afterEach(() => {
    process.env.DEVELOPERS_DOCS_ENABLED = before;
  });

  it("404s while the docs are off", async () => {
    process.env.DEVELOPERS_DOCS_ENABLED = "false";
    const res = agentFile(() => "# hi\n", MARKDOWN);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves Markdown, not indexed, while they're on — and 404s an unknown name", async () => {
    process.env.DEVELOPERS_DOCS_ENABLED = "true";
    const res = agentFile(() => "# hi\n", MARKDOWN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe("# hi\n");
    expect(agentFile(() => null, MARKDOWN).status).toBe(404);
  });
});
