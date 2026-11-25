import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const USAGE_RE = /^usage\(\) \{ sed -n '2,(\d+)p' "\$0"; \}$/m;

function shellScripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : shellScripts(path);
    return name.endsWith(".sh") ? [path] : [];
  });
}

const withUsage = shellScripts(join(ROOT, "infra"))
  .map((path) => ({ path, text: readFileSync(path, "utf8") }))
  .filter(({ text }) => USAGE_RE.test(text));

describe("infra script help", () => {
  it("finds the scripts that print their header as help", () => {
    expect(withUsage.map(({ path }) => relative(ROOT, path))).toContain("infra/lifecycle/setup.sh");
  });

  it.each(withUsage.map(({ path, text }) => [relative(ROOT, path), text]))("%s prints its whole header comment, no more", (_name, text) => {
    const end = Number(USAGE_RE.exec(text)![1]);
    const lines = text.split("\n");
    // Lines are 1-based in sed: lines[1] is line 2.
    const header = lines.slice(1, end);
    expect(header.every((line) => line.startsWith("#"))).toBe(true);
    expect(lines[end]?.startsWith("#") ?? false).toBe(false);
  });
});
