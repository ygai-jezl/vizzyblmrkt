import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every connection route goes through the one gate in src/lib/integrations/admin.ts, so a
// route added later (a GitHub link route, a new provider) can't skip the admin check.
// Each exported handler must call the gate itself or through a function in its own file,
// and only the two status reads may let a member in (adminOnly: false).
const ROOT = join(process.cwd(), "src", "app", "api", "admin", "integrations");

/** Reads a member may make: what is connected, and the GitHub App installation. */
const MEMBER_READS = new Set(["route.ts", join("[provider]", "installation", "route.ts")]);
const METHODS = "GET|POST|PUT|PATCH|DELETE";
const GATE_CALL = /\bintegrations(?:Hop)?Admin\(/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Each top-level function in the file, by name, with its text up to the next one. */
function topLevelFunctions(src: string): Map<string, string> {
  const starts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => ({
    name: m[1]!,
    at: m.index!,
  }));
  const out = new Map<string, string>();
  starts.forEach((s, i) => out.set(s.name, src.slice(s.at, starts[i + 1]?.at ?? src.length)));
  return out;
}

/** A handler's own text plus that of every function in the file it calls, directly or not. */
function reach(name: string, fns: Map<string, string>): string {
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    const body = fns.get(queue.shift()!) ?? "";
    for (const other of fns.keys()) {
      if (!seen.has(other) && new RegExp(`\\b${other}\\(`).test(body)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return [...seen].map((n) => fns.get(n) ?? "").join("\n");
}

/** What is wrong with a route file's handlers: none gated, or one letting a member in. */
function gateProblems(name: string, src: string): string[] {
  const problems: string[] = [];
  // Handlers as arrow functions would be out of this check's sight.
  if (new RegExp(`export\\s+(?:const|let|var)\\s+(?:${METHODS})\\b`).test(src)) problems.push("a handler that isn't a function");
  const fns = topLevelFunctions(src);
  const handlers = [...src.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${METHODS})\\s*\\(`, "gm"))].map(
    (m) => m[1]!,
  );
  if (!handlers.length) problems.push("no handler");
  for (const method of handlers) {
    const text = reach(method, fns);
    if (!GATE_CALL.test(text)) problems.push(`${method} never calls the gate`);
    for (const call of text.matchAll(/\bintegrationsAdmin\(([^)]*)\)/g)) {
      if (call[1]!.includes("adminOnly: true")) continue;
      if (!(MEMBER_READS.has(name) && method === "GET")) problems.push(`${method} lets a member in: ${call[0]}`);
    }
  }
  return problems;
}

describe("integrations routes", () => {
  const files = routeFiles(ROOT);

  it("are all found", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses the integrations gate", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('from "@/lib/integrations/admin"');
    expect(src).not.toContain("getAdminContext");
    expect(src).not.toContain('from "@/lib/auth/session"');
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s gates every handler, admin only unless a member read", (name, file) => {
    expect(gateProblems(name, readFileSync(file, "utf8"))).toEqual([]);
  });

  it("catches a handler that only imports the gate, or lets a member change state", () => {
    const typeOnly =
      'import type { HopGate } from "@/lib/integrations/admin";\nexport async function POST(req: Request) {\n  return ok(req);\n}\n';
    expect(gateProblems("x/route.ts", typeOnly)).toEqual(["POST never calls the gate"]);
    const memberWrite =
      "export async function DELETE(req: Request) {\n  const gate = await integrationsAdmin(req, { adminOnly: false });\n}\n";
    expect(gateProblems("x/route.ts", memberWrite)).toHaveLength(1);
    // The status read may let a member in, but only for GET.
    expect(gateProblems("route.ts", memberWrite.replace("DELETE", "GET"))).toEqual([]);
    expect(gateProblems("route.ts", memberWrite)).toHaveLength(1);
    const viaHelper =
      "async function resolve(req: Request) {\n  return integrationsAdmin(req, { adminOnly: true });\n}\nexport async function PUT(req: Request) {\n  const r = await resolve(req);\n}\n";
    expect(gateProblems("x/route.ts", viaHelper)).toEqual([]);
    expect(gateProblems("x/route.ts", "export const POST = async () => null;\n")).toContain("a handler that isn't a function");
  });
});
