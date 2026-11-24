import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every organisation route (Connectors 3, ADR-0014) checks its switch first, then goes through the
// integrations gate (origin check, sign in, the admin role of the brand the person is in), then the
// live owner check, as routesGate.test.ts holds the connector routes to theirs. Connections answer
// to CONNECTORS_SHARING_ENABLED. No organisation route lets a member in, reads the session itself,
// or takes the organisation or a region from the request.
const ROOT = join(process.cwd(), "src", "app", "api", "admin", "organisation");

const METHODS = "GET|POST|PUT|PATCH|DELETE";
const GATE_CALL = /\bintegrationsAdmin\(/;
const OWNER_CALL = /\borganisationOwner\(/;
const SWITCHES: Record<string, RegExp> = { connections: /\bisConnectorsSharingEnabled\(\)/ };

function routeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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

/** What is wrong with a route file's handlers, for the switch its area answers to. */
function gateProblems(src: string, switchCall: RegExp): string[] {
  const problems: string[] = [];
  if (new RegExp(`export\\s+(?:const|let|var)\\s+(?:${METHODS})\\b`).test(src)) problems.push("a handler that isn't a function");
  const fns = topLevelFunctions(src);
  const handlers = [...src.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${METHODS})\\s*\\(`, "gm"))].map((m) => m[1]!);
  if (!handlers.length) problems.push("no handler");
  for (const method of handlers) {
    const text = fns.get(method) ?? "";
    const switchAt = text.search(switchCall);
    const gateAt = text.search(GATE_CALL);
    const ownerAt = text.search(OWNER_CALL);
    if (switchAt < 0) problems.push(`${method} never checks its switch`);
    if (gateAt < 0) problems.push(`${method} never calls the gate`);
    if (ownerAt < 0) problems.push(`${method} never checks the owner`);
    if (switchAt >= 0 && gateAt >= 0 && switchAt > gateAt) problems.push(`${method} checks the switch after the gate`);
    if (gateAt >= 0 && ownerAt >= 0 && ownerAt < gateAt) problems.push(`${method} checks the owner before the gate`);
    for (const call of text.matchAll(/\bintegrationsAdmin\(([^)]*)\)/g)) {
      if (!call[1]!.includes("adminOnly: true") || !call[1]!.includes("withHome: true")) problems.push(`${method} lets a member in, or has no home brand: ${call[0]}`);
    }
  }
  return problems;
}

describe("organisation routes", () => {
  const files = routeFiles(ROOT);

  it("are all found", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses the integrations gate and never reads the session itself", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('from "@/lib/integrations/admin"');
    expect(src).toContain('from "@/lib/connectors/organisationHttp"');
    expect(src).not.toContain("getAdminContext");
    expect(src).not.toContain('from "@/lib/auth/session"');
    // The organisation and a connection's region come from the server, never from the request.
    expect(src).not.toMatch(/organisationId\s*[:=]\s*(?:body|parsed|req)/);
    expect(src).not.toMatch(/searchParams\.get\(["'](?:organisationId|region)["']\)/);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s checks its switch, then the gate, then the owner, admins only", (name, file) => {
    const area = name.split(/[\\/]/)[0]!;
    const switchCall = SWITCHES[area];
    expect(switchCall, `no switch known for ${area}`).toBeDefined();
    expect(gateProblems(readFileSync(file, "utf8"), switchCall!)).toEqual([]);
  });

  it("catches a handler with no switch, a switch after the gate, a member let in, or no owner check", () => {
    const ok = "export async function POST(req: Request) {\n  if (!isConnectorsSharingEnabled()) return sharingOff();\n  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });\n  const o = await organisationOwner(gate);\n}\n";
    const sw = SWITCHES.connections!;
    expect(gateProblems(ok, sw)).toEqual([]);
    expect(gateProblems(ok.replace("  if (!isConnectorsSharingEnabled()) return sharingOff();\n", ""), sw)).toEqual(["POST never checks its switch"]);
    const late = "export async function POST(req: Request) {\n  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });\n  if (!isConnectorsSharingEnabled()) return sharingOff();\n  const o = await organisationOwner(gate);\n}\n";
    expect(gateProblems(late, sw)).toEqual(["POST checks the switch after the gate"]);
    expect(gateProblems(ok.replace("adminOnly: true", "adminOnly: false"), sw)).toHaveLength(1);
    expect(gateProblems(ok.replace("  const o = await organisationOwner(gate);\n", ""), sw)).toEqual(["POST never checks the owner"]);
  });
});
