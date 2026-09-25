import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vectorsFile from "./vectors.json";

/**
 * Packs the SDK the way npm publishes it (prepack builds dist/), installs the
 * tarball into throwaway consumer projects, and uses it from there: require()
 * and import at runtime, and type-checks under the module settings customers
 * compile with (e.g. Firebase Cloud Functions compile to CommonJS).
 */

const run = promisify(execFile);
const sdkDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(sdkDir, "dist");
const requireHere = createRequire(import.meta.url);
const tscBin = join(dirname(requireHere.resolve("typescript/package.json")), "bin", "tsc");
const typeRoots = dirname(dirname(requireHere.resolve("@types/node/package.json")));

/** The client's methods: constructing it sends nothing, and nothing here calls it. */
const CLIENT_SHAPE = `[yg.users.update, yg.users.batch, yg.users.get, yg.users.delete, yg.events.track, yg.me].map((f) => typeof f)`;

const CJS_CHECK = `
const { YouGrow, YouGrowError, YouGrowBatchError } = require("@yougrowai/node");
const { createVerifier } = require("@yougrowai/node/server");
const vectors = require("./node_modules/@yougrowai/node/test/vectors.json");

(async () => {
  const out = vectors.outbound;
  const verifier = createVerifier({ keyId: out.audience, origin: out.issuer, jwks: out.jwks });
  const tokens = [];
  for (const t of out.tokens) {
    const headers = { authorization: "Bearer " + t.token };
    const asString = await verifier.verify({ headers, rawBody: t.body, direction: t.direction, nowMs: out.nowMs });
    const asBuffer = await verifier.verify({ headers, rawBody: Buffer.from(t.body), direction: t.direction, nowMs: out.nowMs });
    tokens.push([asString.ok, asBuffer.ok]);
  }
  const yg = new YouGrow({ keyId: "k", secret: "s" });
  console.log(JSON.stringify({
    resolved: [require.resolve("@yougrowai/node"), require.resolve("@yougrowai/node/server")],
    version: require("@yougrowai/node/package.json").version,
    tokens,
    client: ${CLIENT_SHAPE},
    errors: [new YouGrowError("x", 400).name, new YouGrowBatchError("x", { applied: 0, ignored: 0, failed: 0, results: [] }).name],
  }));
})();
`;

const ESM_CHECK = `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { YouGrow, YouGrowError, YouGrowBatchError } from "@yougrowai/node";
import { createVerifier } from "@yougrowai/node/server";

const vectors = JSON.parse(readFileSync(new URL("./node_modules/@yougrowai/node/test/vectors.json", import.meta.url), "utf8"));
const out = vectors.outbound;
const verifier = createVerifier({ keyId: out.audience, origin: out.issuer, jwks: out.jwks });
const tokens = [];
for (const t of out.tokens) {
  const headers = { authorization: "Bearer " + t.token };
  const asString = await verifier.verify({ headers, rawBody: t.body, direction: t.direction, nowMs: out.nowMs });
  const asBuffer = await verifier.verify({ headers, rawBody: Buffer.from(t.body), direction: t.direction, nowMs: out.nowMs });
  tokens.push([asString.ok, asBuffer.ok]);
}
const yg = new YouGrow({ keyId: "k", secret: "s" });
console.log(JSON.stringify({
  resolved: [import.meta.resolve("@yougrowai/node"), import.meta.resolve("@yougrowai/node/server")],
  version: createRequire(import.meta.url)("@yougrowai/node/package.json").version,
  tokens,
  client: ${CLIENT_SHAPE},
  errors: [new YouGrowError("x", 400).name, new YouGrowBatchError("x", { applied: 0, ignored: 0, failed: 0, results: [] }).name],
}));
`;

/** Compiles in every module mode below (never runs); the @ts-expect-errors prove the types are real, not `any`. */
const CONSUMER_TS = `
import {
  YouGrow,
  YouGrowBatchError,
  YouGrowError,
  type BatchItem,
  type BatchResponse,
  type EventResult,
  type MeResponse,
  type PatchResponse,
  type UserPatch,
  type UserView,
  type YouGrowOptions,
} from "@yougrowai/node";
import { DEFAULT_ISSUER, contextResponse, createVerifier, type Verifier, type VerifyResult, type WebhookEvent } from "@yougrowai/node/server";

const options: YouGrowOptions = { keyId: "k", secret: "s", origin: process.env.YOUGROW_ORIGIN, timeoutMs: 5_000, maxRetryWaitMs: 1_000 };
const yg = new YouGrow(options);
const patch: UserPatch = { email: "alex@example.com", signedUpAt: new Date(0).toISOString(), consent: "soft_opt_in", steps: { create_brand: null }, traits: { plan: "pro" } };
const items: readonly BatchItem[] = [{ userId: "u1", ...patch }];

export async function sync(): Promise<Array<string | null | boolean | number>> {
  const updated: PatchResponse = await yg.users.update("u1", patch);
  const state = updated.applied ? updated.user.email : updated.reason;
  const batched: BatchResponse = await yg.users.batch(items, { quiet: true, throwOnItemError: false });
  const view: UserView | null = await yg.users.get("u1");
  await yg.users.delete("u1");
  const tracked: EventResult = await yg.events.track("u1", "report.exported", { properties: { format: "pdf" } });
  // @ts-expect-error consent is one of four bases
  await yg.users.update("u1", { consent: "maybe" });
  const me: MeResponse = await yg.me();
  return [state, batched.failed, view?.subscribed ?? null, tracked.duplicate, me.connection.environment];
}

export function onWebhook(raw: string): string {
  const event = JSON.parse(raw) as WebhookEvent;
  if (event.type !== "email.suppressed") return event.type;
  // @ts-expect-error a suppression carries a reason, not a category
  void event.data.category;
  return event.data.reason;
}

const verifier: Verifier = createVerifier({ keyId: "k", origin: process.env.YOUGROW_ORIGIN });
const checked: Promise<VerifyResult> = verifier.verify({ headers: { Authorization: "Bearer x" }, rawBody: Buffer.from("{}"), direction: "context" });
const body: string = contextResponse({ steps: [{ id: "create_brand", label: "Add your brand", done: false }] });
// @ts-expect-error timeoutMs is a number
new YouGrow({ keyId: "k", secret: "s", timeoutMs: "slow" });
export const used = [checked, body, DEFAULT_ISSUER, YouGrowError, YouGrowBatchError];
`;

const TYPE_CHECKS: Array<[project: "cjs" | "esm", module: string, moduleResolution: string]> = [
  ["cjs", "commonjs", "node10"],
  ["cjs", "node16", "node16"],
  ["cjs", "nodenext", "nodenext"],
  ["esm", "nodenext", "nodenext"],
  ["esm", "esnext", "bundler"],
];

let work = "";
let builtDist = false;
const projects = { cjs: "", esm: "" };

/** A consumer project with the packed SDK extracted into node_modules/@yougrowai/node. */
async function project(name: string, tarball: string, pkg: Record<string, unknown>, files: Record<string, string>) {
  const dir = join(work, name);
  const installed = join(dir, "node_modules", "@yougrowai", "node");
  mkdirSync(installed, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, ...pkg }));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

/** Runs a command in `dir`; resolves with its stdout, or rejects with everything it printed. */
async function inDir(dir: string, file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { cwd: dir })).stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "yougrow-sdk-pack-"));
  builtDist = !existsSync(distDir);
  await inDir(sdkDir, "npm", ["pack", "--ignore-scripts=false", "--pack-destination", work]);
  const name = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!name) throw new Error("npm pack made no tarball");
  const tarball = join(work, name);
  projects.cjs = await project("cjs", tarball, {}, { "check.js": CJS_CHECK, "index.ts": CONSUMER_TS });
  projects.esm = await project("esm", tarball, { type: "module" }, { "check.js": ESM_CHECK, "index.ts": CONSUMER_TS });
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  // Leave the tree as we found it: the repo's `eslint .` would lint a stray CommonJS build.
  if (builtDist) rmSync(distDir, { recursive: true, force: true });
});

// Each case spawns node or tsc; under a full test run that can take more than the default 5 s.
describe("the packed SDK", { timeout: 60_000 }, () => {
  it("holds both builds, the vectors, README and LICENSE, and nothing else", () => {
    const root = join(projects.cjs, "node_modules", "@yougrowai", "node");
    const files = (readdirSync(root, { recursive: true }) as string[])
      .map((f) => f.split("\\").join("/"))
      .filter((f) => statSync(join(root, f)).isFile())
      .sort();
    for (const entry of ["index", "server"]) {
      expect(files).toEqual(expect.arrayContaining([`dist/${entry}.js`, `dist/${entry}.d.ts`, `dist/cjs/${entry}.js`, `dist/cjs/${entry}.d.ts`]));
    }
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "README.md", "package.json", "test/vectors.json", "dist/cjs/package.json"]));
    const expected = /^(dist\/(cjs\/)?[a-z]+\.(js|d\.ts)|dist\/cjs\/package\.json|test\/vectors\.json|README\.md|LICENSE|package\.json)$/;
    expect(files.filter((f) => !expected.test(f))).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "dist", "cjs", "package.json"), "utf8"))).toEqual({ type: "commonjs" });
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toMatchObject({ name: "@yougrowai/node", version: "0.4.0" });
  });

  it.each([
    ["require()", "cjs", /\/dist\/cjs\/index\.js$/, /\/dist\/cjs\/server\.js$/],
    ["import", "esm", /\/dist\/index\.js$/, /\/dist\/server\.js$/],
  ] as const)("works with %s: both entry points, every vector", async (_how, which, index, server) => {
    const r = JSON.parse(await inDir(projects[which], process.execPath, ["check.js"])) as {
      resolved: string[];
      tokens: boolean[][];
      version: string;
      client: string[];
      errors: string[];
    };
    expect(r.resolved[0]).toMatch(index);
    expect(r.resolved[1]).toMatch(server);
    expect(r.tokens).toEqual(vectorsFile.outbound.tokens.map(() => [true, true]));
    expect(r.version).toBe("0.4.0");
    expect(r.client).toEqual(Array(6).fill("function"));
    expect(r.errors).toEqual(["YouGrowError", "YouGrowBatchError"]);
  });

  it.concurrent.for(TYPE_CHECKS)("type-checks in a %s project with module %s, moduleResolution %s", async ([which, module, resolution], { expect }) => {
    const args = [tscBin, "--noEmit", "--strict", "--target", "es2022", "--module", module, "--moduleResolution", resolution];
    args.push("--types", "node", "--typeRoots", typeRoots, "index.ts");
    await expect(inDir(projects[which], process.execPath, args)).resolves.toBe("");
  });
});
