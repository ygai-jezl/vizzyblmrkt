import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every Work route (ADR-0018) goes through workAdmin (src/lib/work/http.ts) before anything else:
// the origin check, WORK_ENABLED (404 while off), sign in, then who the person is in Work, read
// live. No Work route reads the session itself, or takes an organisation, a brand's region, a
// tenant or a role from the request.
const ROOT = join(process.cwd(), "src", "app", "api", "admin", "work");
const METHODS = "GET|POST|PUT|PATCH|DELETE";

function routeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Each top level function in the file, by name, with its text up to the next one. */
function topLevelFunctions(src: string): Map<string, string> {
  const starts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => ({ name: m[1]!, at: m.index! }));
  const out = new Map<string, string>();
  starts.forEach((s, i) => out.set(s.name, src.slice(s.at, starts[i + 1]?.at ?? src.length)));
  return out;
}

function gateProblems(src: string): string[] {
  const problems: string[] = [];
  if (new RegExp(`export\\s+(?:const|let|var)\\s+(?:${METHODS})\\b`).test(src)) problems.push("a handler that isn't a function");
  const fns = topLevelFunctions(src);
  const handlers = [...src.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${METHODS})\\s*\\(`, "gm"))].map((m) => m[1]!);
  if (!handlers.length) problems.push("no handler");
  for (const method of handlers) {
    const text = fns.get(method) ?? "";
    const gateAt = text.search(/\bawait workAdmin\(req\)/);
    const firstAwait = text.search(/\bawait\b/);
    if (gateAt < 0) problems.push(`${method} never calls workAdmin(req)`);
    else if (firstAwait !== gateAt) problems.push(`${method} awaits something before workAdmin`);
    if (!/if \(!gate\.ok\) return gate\.response;/.test(text)) problems.push(`${method} doesn't stop on the gate's refusal`);
  }
  return problems;
}

describe("Work routes", () => {
  const files = routeFiles(ROOT);

  it("are all found", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses the Work gate and never reads the session itself", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('from "@/lib/work/http"');
    expect(src).not.toContain("getAdminContext");
    expect(src).not.toContain('from "@/lib/auth/session"');
    expect(src).not.toContain('from "@/lib/tenant"');
    expect(src).toContain('export const runtime = "nodejs"');
    expect(src).toContain('export const dynamic = "force-dynamic"');
    // The organisation, a region, a tenant and a role come from the server, never from the request.
    expect(src).not.toMatch(/(?:organisationId|region|tenantId|role)\s*[:=]\s*(?:body|parsed|req)/);
    expect(src).not.toMatch(/searchParams\.get\(["'](?:organisationId|region|tenantId|role)["']\)/);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s calls workAdmin first in every handler", (_name, file) => {
    expect(gateProblems(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("checks the gate in the order the build-a-feature skill sets: origin, switch, sign in, then Work's scope", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "work", "http.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function workAdmin"));
    const at = (re: RegExp) => body.search(re);
    expect(at(/sameOriginGuard\(req\)/)).toBeGreaterThan(0);
    expect(at(/sameOriginGuard\(req\)/)).toBeLessThan(at(/isWorkEnabled\(\)/));
    expect(at(/isWorkEnabled\(\)/)).toBeLessThan(at(/getAdminContext\(\)/));
    expect(at(/getAdminContext\(\)/)).toBeLessThan(at(/workScopeFor\(ctx\)/));
  });
});
