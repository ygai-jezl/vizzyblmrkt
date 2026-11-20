import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every connection route goes through the one gate in src/lib/integrations/admin.ts, so a
// route added later (a GitHub link route, a new provider) can't skip the admin check.
const ROOT = join(process.cwd(), "src", "app", "api", "admin", "integrations");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

// The X and LinkedIn routes move onto the gate in the next commit.
const NOT_YET = new Set(["x", "linkedin", "linkedin_org"]);

describe("integrations routes", () => {
  const files = routeFiles(ROOT).filter((f) => !NOT_YET.has(relative(ROOT, f).split(/[\\/]/)[0]!));

  it("are all found", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses the integrations gate", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('from "@/lib/integrations/admin"');
    expect(src).not.toContain("getAdminContext");
    expect(src).not.toContain('from "@/lib/auth/session"');
  });
});
