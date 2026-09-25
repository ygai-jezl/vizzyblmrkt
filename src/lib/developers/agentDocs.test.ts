import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { H2 } from "@/components/developers/Doc";
import DevelopersHome from "@/app/developers/page";
import ConnectYourCodeDocs from "@/app/developers/connect-your-code/page";
import ContextEndpointDocs from "@/app/developers/context-endpoint/page";
import EventsMoved from "@/app/developers/events/page";
import { GET as eventsMarkdown } from "@/app/developers/events.md/route";
import SecurityDocs from "@/app/developers/security/page";
import UsersDocs from "@/app/developers/users/page";
import WebhooksDocs from "@/app/developers/webhooks/page";
import { RESERVED_EVENTS } from "@/lib/connect/protocol";
import { EventRequestSchema, UserPatchSchema } from "@/lib/connect/v2/contract";
import vectors from "../../../sdk/node/test/vectors.json";
import { agentFile, agentRedirect, llmsFullTxt, llmsTxt, MARKDOWN, pageMarkdown } from "./agentDocs";
import { DOC_PAGES, hasMarkdown } from "./docs";
import { docsOrigin } from "./flags";
import { SCALAR_SCRIPT, SCALAR_VERSION } from "./scalar";
import { jsonSchema, SCHEMAS } from "./schemas";
import { STATE_NOTES, USER_FIELDS } from "./userFields";

const ORIGIN = "https://yougrow.test";
const PAGES: Record<string, () => ReactNode> = {
  "": DevelopersHome,
  "connect-your-code": ConnectYourCodeDocs,
  users: UsersDocs,
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
  it("has a Markdown twin for every docs page but the API reference, with the same sections", () => {
    expect(DOC_PAGES.filter(hasMarkdown).map((p) => p.slug).sort()).toEqual(Object.keys(PAGES).sort());
    for (const page of DOC_PAGES.filter(hasMarkdown)) {
      const md = pageMarkdown(page.slug, ORIGIN)!;
      const sections = h2s(PAGES[page.slug]!());
      expect(sections.length, page.path).toBeGreaterThan(0);
      expect(md, page.path).toMatch(/^# \S/);
      for (const s of sections) expect(md, `${page.path}: ${s}`).toContain(`\n## ${s}\n`);
      expect(md, page.path).not.toMatch(/\[object Object\]|undefined|NaN/);
    }
    expect(DOC_PAGES.find((p) => p.slug === "api")).toMatchObject({ path: "/developers/api", markdown: false });
    expect(pageMarkdown("api", ORIGIN)).toBeNull();
  });

  it("turns links into absolute URLs, docs links into their .md twins, and leaves the API reference as a page", () => {
    const md = pageMarkdown("", ORIGIN)!;
    expect(md).toContain(`(${ORIGIN}/developers/users.md)`);
    expect(md).toContain(`(${ORIGIN}/developers/connect-your-code.md)`);
    expect(md).toContain(`(${ORIGIN}/developers/api)`);
    expect(md).toContain(`(${ORIGIN}/developers/openapi.json)`);
    expect(md).toContain("(https://www.npmjs.com/package/@yougrowai/node)");
    expect(md).not.toMatch(/\]\(\//); // no relative links left
    expect(md).not.toContain("/developers/events");
  });

  it("documents API v2 with this environment's origin, every field and every response", () => {
    const md = pageMarkdown("users", ORIGIN)!;
    const origin = docsOrigin(); // code samples show this environment's origin
    expect(md).toContain(`curl -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" -X PATCH "${origin}/api/v2/users/user_123"`);
    expect(md).toContain("requests.patch(url, json=patch, auth=AUTH, timeout=10)");
    expect(md).toContain("await yg.users.update(");
    expect(md).toContain("| Field | Type | Notes |");
    for (const key of Object.keys(UserPatchSchema.shape)) expect(md, key).toMatch(new RegExp(`\\| \`${key}\` \\| `));
    expect(md).toMatch(/\| `signedUpAt` \| `string` \| When the account was created/);
    for (const code of ["200 applied: true", "200 applied: false", "204", "400 invalid", "401 unauthorized", "404 not_found", "413 body_too_large", "429 rate_limited"]) {
      expect(md, code).toContain(`| \`${code}\` |`);
    }
    expect(md).toContain("traits: { yg_invite:"); // invited from a waitlist
    const security = pageMarkdown("security", ORIGIN)!;
    expect(security).toContain("## Authenticating your requests");
    expect(security).toContain("> **Important:** Verify against the **raw** body.");
  });

  it("names exactly the events v2 refuses, and allows onboarding.completed", () => {
    const md = pageMarkdown("users", ORIGIN)!;
    for (const name of Object.values(RESERVED_EVENTS)) {
      const refused = !EventRequestSchema.safeParse({ event: name }).success;
      if (refused) expect(md, name).toContain(`\`${name}\``);
    }
    expect(EventRequestSchema.safeParse({ event: RESERVED_EVENTS.onboardingCompleted }).success).toBe(true);
    expect(md).toContain("`onboarding.completed` marks the user activated");
  });

  it("documents every field, in the order of the contract", () => {
    expect(USER_FIELDS.map((f) => f.name)).toEqual(Object.keys(UserPatchSchema.shape));
    expect(Object.keys(STATE_NOTES).length).toBeGreaterThan(0);
  });

  it("mentions API v1 only to say it's gone", () => {
    const full = llmsFullTxt(ORIGIN);
    const v1 = full.split("\n").filter((l) => /api\/v1|HMAC-SHA256|x-yougrow-signature|x-yougrow-timestamp|messageId|identify|onboarding\.step_completed` events/i.test(l));
    expect(v1).toEqual([expect.stringContaining("Removed on 2026-09-25")]);
  });

  it("returns null for a page that doesn't exist", () => {
    expect(pageMarkdown("nope", ORIGIN)).toBeNull();
    expect(pageMarkdown("constructor", ORIGIN)).toBeNull();
    expect(pageMarkdown("events", ORIGIN)).toBeNull();
  });
});

describe("llms.txt and llms-full.txt", () => {
  it("indexes every page with a twin, the OpenAPI spec, every schema and the test vectors", () => {
    const txt = llmsTxt(ORIGIN);
    expect(txt).toMatch(/^# YouGrow\n\n> /);
    for (const p of DOC_PAGES.filter(hasMarkdown)) expect(txt).toContain(`](${ORIGIN}${p.path}.md): `);
    expect(txt).not.toContain(`${ORIGIN}/developers/api.md`);
    expect(txt).toContain(`(${ORIGIN}/developers/openapi.json)`);
    for (const name of Object.keys(SCHEMAS)) expect(txt).toContain(`(${ORIGIN}/developers/schema/${name})`);
    expect(txt).toContain(`(${ORIGIN}/developers/test-vectors.json)`);
    expect(txt).toContain(`(${ORIGIN}/developers/llms-full.txt)`);
    expect(txt).toContain("API v1 (`POST /api/v1/events`, HMAC-signed) was removed on 2026-09-25");
  });

  it("puts every page with a twin in one file, in reading order", () => {
    const full = llmsFullTxt(ORIGIN);
    const pages = DOC_PAGES.filter(hasMarkdown);
    const at = pages.map((p) => full.indexOf(`<!-- ${ORIGIN}${p.path} -->`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(full).not.toContain(`<!-- ${ORIGIN}/developers/api -->`);
  });
});

describe("JSON Schemas", () => {
  it("publishes each API message, generated from the API's validators", () => {
    expect(Object.keys(SCHEMAS)).toEqual([
      "user-patch.json",
      "batch-request.json",
      "event.json",
      "user.json",
      "patch-response.json",
      "batch-response.json",
      "context-request.json",
      "context-response.json",
      "webhook.json",
    ]);
    for (const name of Object.keys(SCHEMAS)) {
      const s = jsonSchema(name, ORIGIN)!;
      expect(s).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${ORIGIN}/developers/schema/${name}` });
      expect(s.type === "object" || Array.isArray(s.anyOf), name).toBe(true);
    }
    expect(jsonSchema("nope.json", ORIGIN)).toBeNull();
    expect(jsonSchema("toString", ORIGIN)).toBeNull();
    expect(jsonSchema("events.json", ORIGIN)).toBeNull(); // API v1 is gone
  });

  it("describes what you send strictly, with the contract's limits and the field notes", () => {
    type Obj = { properties: Record<string, { description?: string; maxProperties?: number }>; additionalProperties?: unknown; required?: string[] };
    const patch = jsonSchema("user-patch.json", ORIGIN) as unknown as Obj;
    expect(Object.keys(patch.properties)).toEqual(Object.keys(UserPatchSchema.shape));
    expect(patch.additionalProperties).toBe(false); // unknown fields are refused
    expect(patch.required).toBeUndefined(); // every field is optional
    expect(patch.properties.steps!.maxProperties).toBe(50);
    expect(patch.properties.signedUpAt!.description).toMatch(/^When the account was created/);

    const batch = jsonSchema("batch-request.json", ORIGIN) as unknown as { properties: { users: { maxItems: number; minItems: number; items: Obj } } };
    expect(batch.properties.users).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(batch.properties.users.items.required).toEqual(["userId"]);
    expect(batch.properties.users.items.properties.userId!.description).toMatch(/^Your own id for the user/);

    const response = jsonSchema("context-response.json", ORIGIN) as { required?: string[] };
    expect(response.required).toEqual(["asOf"]); // what a customer sends: defaults are optional
  });

  it("lets what we send gain fields", () => {
    for (const name of ["user.json", "batch-response.json", "context-request.json", "webhook.json"]) {
      expect(JSON.stringify(jsonSchema(name, ORIGIN)), name).not.toContain('"additionalProperties":false');
    }
    const user = jsonSchema("user.json", ORIGIN) as { properties: Record<string, { description?: string }> };
    expect(user.properties.optOuts!.description).toContain("The API can't lift them");
  });

  it("serves the same test vectors the SDK pins", () => {
    expect(vectors.outbound.tokens.length).toBeGreaterThan(0);
    expect(vectors.outbound.jwks.keys.length).toBeGreaterThan(0);
  });
});

describe("the API reference viewer", () => {
  it("loads Scalar pinned to an exact version, with Subresource Integrity", () => {
    expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCALAR_SCRIPT.src).toBe(`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`);
    expect(SCALAR_SCRIPT.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
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
    expect(agentRedirect("/developers/users.md").status).toBe(404);
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

describe("the old events page", () => {
  const before = process.env.DEVELOPERS_DOCS_ENABLED;
  afterEach(() => {
    process.env.DEVELOPERS_DOCS_ENABLED = before;
  });

  it("redirects permanently to Sending users", () => {
    let thrown: unknown;
    try {
      EventsMoved();
    } catch (err) {
      thrown = err;
    }
    expect(String((thrown as { digest?: string }).digest)).toMatch(/^NEXT_REDIRECT;replace;\/developers\/users;308;/);
  });

  it("sends agents from events.md to users.md with a 301", () => {
    process.env.DEVELOPERS_DOCS_ENABLED = "true";
    const res = eventsMarkdown();
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/developers/users.md");
    process.env.DEVELOPERS_DOCS_ENABLED = "false";
    expect(eventsMarkdown().status).toBe(404);
  });
});
