import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Production serves public/ from the standalone build. If the config traces only part of public/,
 * Next creates .next/standalone/public holding just that part, and an App Hosting adapter that
 * skips folders already there (14.0.21 and before) leaves every other public file out: the share
 * image, the logo, the connector marks and the Sign in with Google button all answered 404 in
 * production from 19 Oct 2026. So the trace must cover the whole folder.
 */

const ROOT = join(__dirname, "..", "..");

function publicFiles(dir = join(ROOT, "public")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...publicFiles(path));
    else out.push(relative(ROOT, path).split(sep).join("/"));
  }
  return out;
}

describe("public files in the production build", () => {
  const includes = Object.values(nextConfig.outputFileTracingIncludes ?? {}).flat();

  it("traces the whole public folder, so no adapter can leave part of it out", () => {
    expect(includes).toContain("./public/**/*");
  });

  it("never traces only part of public/", () => {
    const partial = includes.filter((g) => g.startsWith("./public/") && g !== "./public/**/*");
    expect(partial).toEqual([]);
  });

  it("has the files pages link to", () => {
    const files = publicFiles();
    for (const path of ["public/og/yougrow-loop.png", "public/brand/yougrow-logo.png", "public/marks/google/signin-light.png", "public/marks/google/signin-dark.png"]) {
      expect(files).toContain(path);
    }
  });
});
