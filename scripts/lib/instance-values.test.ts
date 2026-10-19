import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allowedBy, findInstanceValues, globToRegExp, parseAllowList } from "./instance-values.mjs";

describe("findInstanceValues", () => {
  it("finds each kind of value with its line and column", () => {
    const text = [
      'const a = "https://yougrow.ai/privacy";',
      "// sent from noreply@vizzybl.ai",
      "project: vizzybl-marketing-prod, tenant ten_vzb_user-1 or ten_yougrow-ai",
      "https://my-backend--my-project.us-central1.hosted.app/api",
      "gtag('config', 'G-ABCDE12345')",
    ].join("\n");
    const hits = findInstanceValues(text);
    expect(hits.map((h) => [h.line, h.value])).toEqual([
      [1, "yougrow.ai"],
      [2, "vizzybl.ai"],
      [3, "vizzybl-marketing-prod"],
      [3, "ten_vzb"],
      [3, "ten_yougrow-ai"],
      [4, "my-backend--my-project.us-central1.hosted.app"],
      [5, "G-ABCDE12345"],
    ]);
    expect(hits[0]).toMatchObject({ column: 20, pattern: "our product domain" });
  });

  it("leaves neutral text alone: the product name, example domains, generic hosting suffixes", () => {
    const text = [
      'title: "YouGrow"',
      "https://app.example.com and you@example.com",
      'const RESERVED = [".hosted.app", ".run.app"];',
      "demo-yougrow, ten_demo, G-SHORT",
    ].join("\n");
    expect(findInstanceValues(text)).toEqual([]);
  });

  it("never names a value in its own source, so the checker needs no allowlist entry", () => {
    const source = readFileSync(new URL("./instance-values.mjs", import.meta.url), "utf8");
    expect(findInstanceValues(source)).toEqual([]);
  });
});

describe("globToRegExp", () => {
  it("matches ** across directories (also none), * and ? within one", () => {
    expect(globToRegExp("**/*.test.ts").test("src/lib/a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("src/lib/a.ts")).toBe(false);
    expect(globToRegExp("infra/**").test("infra/lifecycle/setup.sh")).toBe(true);
    expect(globToRegExp("infra/").test("infra/x/y.md")).toBe(true);
    expect(globToRegExp("infra/**").test("src/infra/x.ts")).toBe(false);
    expect(globToRegExp("scripts/*.ts").test("scripts/a.ts")).toBe(true);
    expect(globToRegExp("scripts/*.ts").test("scripts/lib/a.ts")).toBe(false);
    expect(globToRegExp("docs/SETUP?md").test("docs/SETUP.md")).toBe(true);
  });

  it("treats every other character literally", () => {
    expect(globToRegExp(".firebaserc").test(".firebaserc")).toBe(true);
    expect(globToRegExp(".firebaserc").test("xfirebaserc")).toBe(false);
    expect(globToRegExp("a+b(c).json").test("a+b(c).json")).toBe(true);
  });
});

describe("parseAllowList", () => {
  it("reads globs with reasons, skips comments, and refuses an entry without a reason", () => {
    const { entries, errors } = parseAllowList(
      ["# comment", "", "infra/**   # our setup scripts", "docs/SETUP.md #docs about our hosting", "apphosting.yaml"].join("\n"),
    );
    expect(entries.map((e) => [e.glob, e.reason, e.line])).toEqual([
      ["infra/**", "our setup scripts", 3],
      ["docs/SETUP.md", "docs about our hosting", 4],
    ]);
    expect(errors).toEqual([expect.stringContaining('line 5: "apphosting.yaml" has no reason')]);
    expect(allowedBy("infra/x/setup.sh", entries)?.glob).toBe("infra/**");
    expect(allowedBy("src/app/page.tsx", entries)).toBeNull();
  });

  it("parses the real allowlist without errors, and every entry says why", () => {
    const text = readFileSync(new URL("../instance-values.allow", import.meta.url), "utf8");
    const { entries, errors } = parseAllowList(text);
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.reason.length, e.glob).toBeGreaterThan(5);
    // Runtime code stays checked: nothing under src/ is allowed wholesale.
    expect(allowedBy("src/app/page.tsx", entries)).toBeNull();
    expect(allowedBy("src/lib/site/flags.ts", entries)).toBeNull();
    expect(allowedBy("workers/knowledge-scraper/src/render.ts", entries)).toBeNull();
  });
});
