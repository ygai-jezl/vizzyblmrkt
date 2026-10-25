import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPONENTS, openApiSpec } from "./openapi";

type S = Record<string, unknown>;
const ORIGIN = "https://yougrow.test";

afterEach(() => vi.unstubAllEnvs());

/** Every `examples` block under a node, with the schema it claims. */
function examples(node: unknown, out: Array<{ schema: string; label: string; value: unknown }> = []) {
  if (Array.isArray(node)) node.forEach((n) => examples(n, out));
  else if (node && typeof node === "object") {
    const o = node as S;
    if (o.examples && o.schema && typeof (o.schema as S).$ref === "string") {
      const schema = ((o.schema as S).$ref as string).split("/").pop()!;
      for (const [label, ex] of Object.entries(o.examples as S)) out.push({ schema, label, value: (ex as S).value });
    }
    Object.values(o).forEach((v) => examples(v, out));
  }
  return out;
}

describe("POST /api/v2/signups in the OpenAPI spec (LAUNCH_SITE_SIGNUPS_ENABLED)", () => {
  it("isn't there while the switch is off", () => {
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "false");
    const spec = openApiSpec(ORIGIN) as { paths: S; tags: Array<{ name: string }>; components: { securitySchemes: S } };
    expect(Object.keys(spec.paths)).not.toContain("/api/v2/signups");
    expect(spec.tags.map((t) => t.name)).not.toContain("Sign-ups");
    expect(spec.components.securitySchemes).not.toHaveProperty("siteKeyAuth");
  });

  it("is there while it's on, with its own key, served by a route, every example valid", () => {
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true");
    const spec = openApiSpec(ORIGIN) as { paths: Record<string, Record<string, S>>; components: { securitySchemes: S } };
    const op = spec.paths["/api/v2/signups"]!.post!;
    expect(op.security).toEqual([{ siteKeyAuth: [] }]);
    expect(spec.components.securitySchemes).toHaveProperty("siteKeyAuth");
    expect(Object.keys(op.responses as S).sort()).toEqual(["200", "202", "400", "401", "404", "409", "413", "429", "503"]);
    const route = `${process.cwd()}/src/app/api/v2/signups/route.ts`;
    expect(existsSync(route)).toBe(true);
    expect(readFileSync(route, "utf8")).toMatch(/export\s+async\s+function\s+POST\b/);
    const found = examples(op);
    expect(found.length).toBeGreaterThanOrEqual(8);
    for (const { schema, label, value } of found) {
      const parsed = COMPONENTS[schema]!.schema.safeParse(value);
      expect(parsed.success, `${schema} ${label}`).toBe(true);
    }
  });
});
