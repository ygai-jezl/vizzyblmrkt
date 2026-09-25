import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GET as openApiJson } from "@/app/developers/openapi.json/route";
import { BatchItemSchema, BatchRequestSchema, UserPatchSchema, UserViewSchema, V2_PATHS } from "@/lib/connect/v2/contract";
import { COMPONENTS, openApiSpec } from "./openapi";

type S = Record<string, unknown>;

const ORIGIN = "https://yougrow.test";
const spec = openApiSpec(ORIGIN) as S & {
  paths: Record<string, Record<string, S>>;
  webhooks: Record<string, Record<string, S>>;
  components: { schemas: Record<string, S & { properties?: Record<string, S> }>; responses: Record<string, S>; securitySchemes: Record<string, S> };
};
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const isObj = (v: unknown): v is S => typeof v === "object" && v !== null && !Array.isArray(v);

function operations(paths: Record<string, Record<string, unknown>>): Array<[string, string, S]> {
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.has(method))
      .map(([method, op]) => [path, method, op as S] as [string, string, S]),
  );
}

function resolve(ref: string): S {
  expect(ref.startsWith("#/"), ref).toBe(true);
  let node: unknown = spec;
  for (const part of ref.slice(2).split("/")) node = isObj(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  expect(isObj(node), `${ref} resolves`).toBe(true);
  return node as S;
}

/** Every node in the document, with where it is. */
function* nodes(node: unknown, where = "#"): Generator<[S, string]> {
  if (Array.isArray(node)) {
    for (const [i, n] of node.entries()) yield* nodes(n, `${where}/${i}`);
  } else if (isObj(node)) {
    yield [node, where];
    for (const [k, v] of Object.entries(node)) yield* nodes(v, `${where}/${k}`);
  }
}

/**
 * Just enough JSON Schema (2020-12) to check the examples against the schemas the
 * spec publishes — the keywords z.toJSONSchema emits. Returns the problems found.
 */
function check(schema: S, value: unknown, at = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const { $ref, ...siblings } = schema;
    return [...check(resolve($ref as string), value, at), ...check(siblings, value, at)];
  }
  const errs: string[] = [];
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => check(s as S, value, at).length === 0)) errs.push(`${at}: matches nothing in anyOf`);
  if ("const" in schema && value !== schema.const) errs.push(`${at}: isn't ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${at}: isn't one of ${schema.enum.join(", ")}`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const is: Record<string, (v: unknown) => boolean> = {
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number" && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
    null: (v) => v === null,
    object: isObj,
    array: Array.isArray,
  };
  if (types.length && !types.some((t) => is[t as string]?.(value))) return [...errs, `${at}: isn't ${types.join(" or ")}`];
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${at}: too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: doesn't match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${at}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${at}: too many items`);
    if (isObj(schema.items)) value.forEach((v, i) => errs.push(...check(schema.items as S, v, `${at}[${i}]`)));
  }
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (!(key in value)) errs.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (isObj(schema.propertyNames)) errs.push(...check(schema.propertyNames, key, `${at} key "${key}"`));
      if (isObj(props[key])) errs.push(...check(props[key] as S, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unknown field ${key}`);
      else if (isObj(schema.additionalProperties)) errs.push(...check(schema.additionalProperties, v, `${at}.${key}`));
    }
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) errs.push(`${at}: too many keys`);
  }
  return errs;
}

describe("the OpenAPI spec", () => {
  it("is an OpenAPI 3.1 document for this origin, with Basic auth for the API and a JWT for what YouGrow sends", () => {
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(spec.info).toMatchObject({ title: "YouGrow API", version: expect.stringMatching(/^2\./) });
    expect(spec.servers).toEqual([{ url: ORIGIN }]);
    expect(spec.security).toEqual([{ basicAuth: [] }]);
    expect(spec.components.securitySchemes.basicAuth).toMatchObject({ type: "http", scheme: "basic" });
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(spec.components.securitySchemes.bearerAuth!.description).toContain(`${ORIGIN}/.well-known/jwks.json`);
    expect(spec.components.securitySchemes.bearerAuth!.description).toContain("ES256");
  });

  it("gives every operation an id, a summary and described responses", () => {
    const all = [...operations(spec.paths), ...operations(spec.webhooks)];
    const ids = all.map(([, , op]) => op.operationId);
    expect(new Set(ids).size).toBe(all.length);
    for (const [path, method, op] of all) {
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      const responses = op.responses as Record<string, S>;
      expect(Object.keys(responses).length, `${method} ${path}`).toBeGreaterThan(0);
      for (const [code, r] of Object.entries(responses)) {
        expect(code, `${method} ${path}`).toMatch(/^[1-5](\d\d|XX)$/);
        const response = typeof r.$ref === "string" ? resolve(r.$ref) : r;
        expect(response.description, `${method} ${path} ${code}`).toBeTruthy();
      }
    }
  });

  it("resolves every $ref", () => {
    let refs = 0;
    for (const [node] of nodes(spec)) {
      if (typeof node.$ref === "string") {
        resolve(node.$ref);
        refs += 1;
      }
    }
    expect(refs).toBeGreaterThan(20);
  });

  it("covers exactly the contract's paths, each served by a route that exports the method", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(Object.values(V2_PATHS).sort());
    const ops = operations(spec.paths).map(([path, method]) => `${method.toUpperCase()} ${path}`);
    expect(ops.sort()).toEqual(
      [
        "PATCH /api/v2/users/{userId}",
        "GET /api/v2/users/{userId}",
        "DELETE /api/v2/users/{userId}",
        "POST /api/v2/users/batch",
        "POST /api/v2/users/{userId}/events",
        "GET /api/v2/me",
      ].sort(),
    );
    for (const [path, method] of operations(spec.paths)) {
      const file = `${ROOT}/src/app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      expect(existsSync(file), file).toBe(true);
      const verb = method.toUpperCase();
      expect(readFileSync(file, "utf8"), `${verb} in ${file}`).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${verb}\\b|export\\s+const\\s+${verb}\\b`));
    }
  });

  it("builds its schemas from the contract, with a description for every field", () => {
    const c = spec.components.schemas;
    expect(Object.keys(c).sort()).toEqual(Object.keys(COMPONENTS).sort());
    expect(Object.keys(c.UserPatch!.properties!)).toEqual(Object.keys(UserPatchSchema.shape));
    expect(Object.keys(c.BatchItem!.properties!)).toEqual(["userId", ...Object.keys(UserPatchSchema.shape)]);
    expect(Object.keys(c.UserView!.properties!)).toEqual(Object.keys(UserViewSchema.shape));
    for (const name of ["UserPatch", "BatchItem", "UserState", "UserView", "EventRequest"]) {
      for (const [field, p] of Object.entries(c[name]!.properties!)) expect(p.description, `${name}.${field}`).toBeTruthy();
    }
    for (const [name, s] of Object.entries(c)) expect(s.description, name).toBeTruthy();
    expect(c.UserPatch!.additionalProperties).toBe(false); // unknown fields are refused…
    expect(JSON.stringify(c.UserView)).not.toContain('"additionalProperties":false'); // …but what we send may gain some
    expect(c.UserPatch!.properties!.traits!.maxProperties).toBe(50);
  });

  it("describes what YouGrow sends you — the context request and webhooks — each verified with a JWT", () => {
    expect(Object.keys(spec.webhooks)).toEqual(["contextRequest", "webhook"]);
    const media = (schema: string) => ({ "application/json": expect.objectContaining({ schema: { $ref: `#/components/schemas/${schema}` } }) });
    const context = spec.webhooks.contextRequest!.post!;
    const webhook = spec.webhooks.webhook!.post!;
    for (const op of [context, webhook]) expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect((context.requestBody as S).content).toEqual(media("ContextRequest"));
    expect(((context.responses as Record<string, S>)["200"]!).content).toEqual(media("ContextResponse"));
    expect((webhook.requestBody as S).content).toEqual(media("WebhookPayload"));
  });

  it("checks every example against its schema — the API's own validator and the published JSON Schema", () => {
    let checked = 0;
    for (const [node, where] of nodes(spec)) {
      if (!isObj(node.examples) || !isObj(node.schema)) continue;
      const ref = node.schema.$ref;
      expect(typeof ref, `${where}: examples need a $ref schema`).toBe("string");
      const name = (ref as string).split("/").pop()!;
      const component = COMPONENTS[name];
      expect(component, `${where}: ${name}`).toBeDefined();
      for (const [label, example] of Object.entries(node.examples)) {
        const value = (example as S).value;
        const parsed = component!.schema.safeParse(value);
        expect(parsed.success, `${where} ${label}: ${parsed.error?.message}`).toBe(true);
        expect(check(node.schema, value), `${where} ${label}`).toEqual([]);
        if (name === "BatchRequest") {
          // …and the checks the batch route really runs: the envelope, then each item.
          expect(BatchRequestSchema.safeParse(value).success).toBe(true);
          for (const item of (value as { users: unknown[] }).users) {
            const head = BatchItemSchema.parse(item);
            const { userId: _userId, ...patch } = head;
            expect(UserPatchSchema.safeParse(patch).success, JSON.stringify(item)).toBe(true);
          }
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(25);
  });

  it("has a schema checker that does catch a bad example", () => {
    const patch = { $ref: "#/components/schemas/UserPatch" };
    expect(check(patch, { email: "alex@example.com", steps: { create_project: "2026-09-25T10:00:00Z" } })).toEqual([]);
    expect(check(patch, { bogus: true })).toEqual(["$: unknown field bogus"]);
    expect(check(patch, { steps: { "Not An Id": null } }).length).toBeGreaterThan(0);
    expect(check(patch, { subscribed: "no" }).length).toBeGreaterThan(0);
    expect(check(patch, { signedUpAt: "yesterday" }).length).toBeGreaterThan(0);
  });
});

describe("/developers/openapi.json", () => {
  const before = process.env.DEVELOPERS_DOCS_ENABLED;
  afterEach(() => {
    process.env.DEVELOPERS_DOCS_ENABLED = before;
  });

  it("serves the spec as JSON while the docs are on, and 404s while they're off", async () => {
    process.env.DEVELOPERS_DOCS_ENABLED = "true";
    const res = openApiJson();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const served = (await res.json()) as S;
    expect(served.openapi).toBe(spec.openapi);
    expect(Object.keys(served.paths as S)).toEqual(Object.keys(spec.paths));
    process.env.DEVELOPERS_DOCS_ENABLED = "false";
    expect(openApiJson().status).toBe(404);
  });
});
