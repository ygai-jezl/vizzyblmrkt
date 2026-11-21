import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every connector route goes through the integrations gate (src/lib/integrations/admin.ts), as
// the integrations routes do (src/lib/integrations/routesGate.test.ts), so a route added later
// (Connectors 1b's start and callback, 1c's share access) can't skip the admin check. Each
// exported handler must check CONNECTORS_ENABLED first and then call the gate itself or through a
// function in its own file, and only the three reads may let a member in (adminOnly: false):
// the list, one connection and its live read, where the grants table decides the rest.
const ROOT = join(process.cwd(), "src", "app", "api", "admin", "connectors");

const MEMBER_READS = new Set(["route.ts", join("connections", "[connectionId]", "route.ts"), join("connections", "[connectionId]", "live", "route.ts")]);
const METHODS = "GET|POST|PUT|PATCH|DELETE";
const GATE_CALL = /\bintegrations(?:Hop)?Admin\(/;
const SWITCH_CALL = /\bisConnectorsEnabled\(\)/;

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
  const starts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => ({ name: m[1]!, at: m.index! }));
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

/** What is wrong with a route file's handlers. */
function gateProblems(name: string, src: string): string[] {
  const problems: string[] = [];
  if (new RegExp(`export\\s+(?:const|let|var)\\s+(?:${METHODS})\\b`).test(src)) problems.push("a handler that isn't a function");
  const fns = topLevelFunctions(src);
  const handlers = [...src.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${METHODS})\\s*\\(`, "gm"))].map((m) => m[1]!);
  if (!handlers.length) problems.push("no handler");
  for (const method of handlers) {
    const text = reach(method, fns);
    if (!GATE_CALL.test(text)) problems.push(`${method} never calls the gate`);
    const switchAt = text.search(SWITCH_CALL);
    const gateAt = text.search(GATE_CALL);
    if (switchAt < 0) problems.push(`${method} never checks CONNECTORS_ENABLED`);
    else if (gateAt >= 0 && switchAt > gateAt) problems.push(`${method} checks the switch after the gate`);
    for (const call of text.matchAll(/\bintegrationsAdmin\(([^)]*)\)/g)) {
      if (call[1]!.includes("adminOnly: true")) continue;
      if (!(MEMBER_READS.has(name) && method === "GET")) problems.push(`${method} lets a member in: ${call[0]}`);
    }
  }
  return problems;
}

describe("connector routes", () => {
  const files = routeFiles(ROOT);

  it("are all found", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses the integrations gate", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('from "@/lib/integrations/admin"');
    expect(src).not.toContain("getAdminContext");
    expect(src).not.toContain('from "@/lib/auth/session"');
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s checks the switch, then gates every handler, admin only unless a member read", (name, file) => {
    expect(gateProblems(name, readFileSync(file, "utf8"))).toEqual([]);
  });

  it("catches a handler with no switch, a switch after the gate, or a member let into a write", () => {
    const noSwitch = "export async function POST(req: Request) {\n  const gate = await integrationsAdmin(req, { adminOnly: true });\n}\n";
    expect(gateProblems("x/route.ts", noSwitch)).toEqual(["POST never checks CONNECTORS_ENABLED"]);
    const late = "export async function POST(req: Request) {\n  const gate = await integrationsAdmin(req, { adminOnly: true });\n  if (!isConnectorsEnabled()) return off();\n}\n";
    expect(gateProblems("x/route.ts", late)).toEqual(["POST checks the switch after the gate"]);
    const memberWrite = "export async function DELETE(req: Request) {\n  if (!isConnectorsEnabled()) return off();\n  const gate = await integrationsAdmin(req, { adminOnly: false });\n}\n";
    expect(gateProblems(join("connections", "[connectionId]", "route.ts"), memberWrite)).toHaveLength(1);
    expect(gateProblems(join("connections", "[connectionId]", "route.ts"), memberWrite.replace("DELETE", "GET"))).toEqual([]);
    expect(gateProblems(join("connections", "[connectionId]", "check", "route.ts"), memberWrite.replace("DELETE", "GET"))).toHaveLength(1);
  });
});
