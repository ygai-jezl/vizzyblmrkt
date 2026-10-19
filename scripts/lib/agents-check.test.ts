import { describe, expect, it } from "vitest";
import {
  codeSnippets,
  envDocumented,
  envReads,
  frontmatter,
  isCreatedPath,
  isEnvSourceFile,
  lineCount,
  npmCommandProblem,
  npmCommands,
  pathIndex,
  pathWords,
  repoPathRef,
  skillProblems,
} from "./agents-check.mjs";

// The scan of this repo itself is npm run agents:check, which CI runs.

describe("codeSnippets", () => {
  it("returns inline spans and fenced lines, with their line numbers", () => {
    const md = ["Run `npm run doctor` and `npm test`.", "", "```bash", "npm ci", "# a comment", "", "npm run local", "```", "After `x`."].join("\n");
    expect(codeSnippets(md)).toEqual([
      { text: "npm run doctor", line: 1, fenced: false, cd: "" },
      { text: "npm test", line: 1, fenced: false, cd: "" },
      { text: "npm ci", line: 4, fenced: true, cd: "" },
      { text: "npm run local", line: 7, fenced: true, cd: "" },
      { text: "x", line: 9, fenced: false, cd: "" },
    ]);
  });

  it("follows a cd line inside a fence, and forgets it after the fence", () => {
    const md = ["```", "cd workers/knowledge-scraper", "npm test", "```", "```", "npm test", "```"].join("\n");
    expect(codeSnippets(md).map((s) => [s.text, s.cd])).toEqual([
      ["npm test", "workers/knowledge-scraper"],
      ["npm test", ""],
    ]);
  });

  it("doesn't read spans inside a fence, and handles ~~~ fences", () => {
    const md = ["~~~", "echo `date`", "```", "still code", "~~~", "`after`"].join("\n");
    expect(codeSnippets(md).map((s) => s.text)).toEqual(["echo `date`", "```", "still code", "after"]);
  });
});

describe("npmCommands", () => {
  it("finds scripts and npm's own commands", () => {
    expect(npmCommands("npm run doctor -- --brief")).toEqual([{ kind: "run", name: "doctor", cd: "" }]);
    expect(npmCommands("npm ci && npm test")).toEqual([
      { kind: "command", name: "ci", cd: "" },
      { kind: "command", name: "test", cd: "" },
    ]);
    expect(npmCommands("npm install -g firebase-tools")).toEqual([{ kind: "command", name: "install", cd: "" }]);
  });

  it("notes the folder a cd moves to", () => {
    expect(npmCommands("cd workers/knowledge-scraper && npm run typecheck && npm test")).toEqual([
      { kind: "run", name: "typecheck", cd: "workers/knowledge-scraper" },
      { kind: "command", name: "test", cd: "workers/knowledge-scraper" },
    ]);
  });

  it("skips placeholders, flags and other tools", () => {
    expect(npmCommands("npm run <script>")).toEqual([]);
    expect(npmCommands("npm run")).toEqual([]);
    expect(npmCommands("npm -v")).toEqual([]);
    expect(npmCommands("npx vitest run src")).toEqual([]);
    expect(npmCommands("pnpm run build")).toEqual([]);
  });
});

describe("npmCommandProblem", () => {
  const scripts = { doctor: "node scripts/doctor.mjs", test: "vitest run", local: "node scripts/local.mjs" };
  const problem = (cmd: { kind: "run" | "command"; name: string }) => npmCommandProblem(cmd, scripts, "package.json");

  it("accepts scripts that exist and npm's own commands", () => {
    expect(problem({ kind: "run", name: "doctor" })).toBe("");
    expect(problem({ kind: "command", name: "test" })).toBe("");
    expect(problem({ kind: "command", name: "ci" })).toBe("");
    expect(problem({ kind: "command", name: "install" })).toBe("");
  });

  it("names a missing script", () => {
    expect(problem({ kind: "run", name: "nope" })).toBe('`npm run nope`: package.json has no "nope" script');
  });

  it("says when a script needs `npm run`", () => {
    expect(problem({ kind: "command", name: "local" })).toContain("write `npm run local`");
    // `npm doctor` is npm's own check, not ours.
    expect(problem({ kind: "command", name: "doctor" })).toContain("runs npm's own command");
    expect(problem({ kind: "command", name: "frob" })).toBe("`npm frob` is neither an npm command nor a script in package.json");
  });
});

describe("pathWords", () => {
  it("cleans quotes, punctuation and assignments, and drops what can't be a path", () => {
    expect(pathWords('PROJECT=<id> bash "infra/agent/setup.sh" all, docs/self-host.md. --dry-run $HOME https://x.test/a firebase-tools@15.27.0 @/lib/tenant')).toEqual([
      "<id>",
      "bash",
      "infra/agent/setup.sh",
      "all",
      "docs/self-host.md",
      "@/lib/tenant",
    ]);
  });
});

describe("repoPathRef", () => {
  const exists = pathIndex(["AGENTS.md", "src/lib/tenant/index.ts", "sdk/node/test/vectors.json", "sdk/node/package.json", "docs/self-host.md"]);

  it("checks paths under the known folders from the root", () => {
    expect(repoPathRef("src/lib/tenant", "", exists)).toMatchObject({ candidates: ["src/lib/tenant"], glob: false });
    expect(repoPathRef("docs/self-host.md#keep-your-fork-up-to-date", "", exists)).toMatchObject({ candidates: ["docs/self-host.md"] });
    expect(repoPathRef("src/app/page.tsx:12", "", exists)).toMatchObject({ candidates: ["src/app/page.tsx"] });
  });

  it("checks only the fixed start of a placeholder or wildcard path", () => {
    expect(repoPathRef(".claude/skills/<name>/SKILL.md", "", exists)).toMatchObject({ candidates: [".claude/skills"], glob: true });
    expect(repoPathRef("src/lib/tenant/**", "", exists)).toMatchObject({ candidates: ["src/lib/tenant"], glob: true });
    expect(repoPathRef("src/app/api/waitlist/[campaignId]/route.ts", "", exists)).toMatchObject({ glob: false });
  });

  it("checks bare root files, but not words that only look like them", () => {
    expect(repoPathRef("AGENTS.md", "", exists)).toMatchObject({ candidates: ["AGENTS.md"] });
    expect(repoPathRef(".env.example", "", exists)).toMatchObject({ candidates: [".env.example"] });
    expect(repoPathRef(".nvmrc", "", exists)).toMatchObject({ candidates: [".nvmrc"] });
    for (const word of [".test", ".env", "flags.ts", "example.com", "ctx.tenantId", "admin/", "tenant/"]) {
      expect(repoPathRef(word, "", exists)).toBeNull();
    }
  });

  it("looks beside a subfolder's guide first, then at the root", () => {
    expect(repoPathRef("package.json", "sdk/node", exists)).toMatchObject({ candidates: ["sdk/node/package.json", "package.json"] });
    expect(repoPathRef("src/lib/tenant", "sdk/node", exists)).toMatchObject({ candidates: ["sdk/node/src/lib/tenant", "src/lib/tenant"] });
    expect(repoPathRef("test/vectors.json", "sdk/node", exists)).toMatchObject({ candidates: ["sdk/node/test/vectors.json"] });
    expect(repoPathRef("test/vectors.json", "", exists)).toBeNull();
  });

  it("maps the @/ import alias to src/, trying the module file names", () => {
    const ref = repoPathRef("@/lib/auth/session", "sdk/node", exists);
    expect(ref?.target).toBe("src/lib/auth/session");
    expect(ref?.candidates).toContain("src/lib/auth/session.ts");
  });

  it("skips URL paths, home and parent folders", () => {
    for (const word of ["/api/health", "~/.cache/firebase", "../.venv/bin/python"]) expect(repoPathRef(word, "", exists)).toBeNull();
  });
});

describe("pathIndex and isCreatedPath", () => {
  it("knows files and the folders that hold them", () => {
    const exists = pathIndex(["src/lib/tenant/index.ts"]);
    expect(exists("src/lib/tenant/index.ts")).toBe(true);
    expect(exists("src/lib")).toBe(true);
    expect(exists("src/lib/")).toBe(true);
    expect(exists("src/li")).toBe(false);
  });

  it("allows the paths people create, and inside them", () => {
    expect(isCreatedPath(".env.local")).toBe(true);
    expect(isCreatedPath("agents/.venv/bin/pip")).toBe(true);
    expect(isCreatedPath("agents/.venvy")).toBe(false);
  });
});

describe("skill frontmatter", () => {
  const skill = (fields: string, body = "# Body\n") => `---\n${fields}\n---\n\n${body}`;

  it("reads the YAML block", () => {
    expect(frontmatter(skill("name: run-locally\ndescription: Run it."))).toEqual({ data: { name: "run-locally", description: "Run it." }, error: "" });
    expect(frontmatter("# No frontmatter").error).toContain("no frontmatter");
    expect(frontmatter(skill("name: [unclosed")).error).toContain("isn't valid YAML");
  });

  it("accepts a valid skill", () => {
    expect(skillProblems("run-locally", skill("name: run-locally\ndescription: Run YouGrow locally.\nlicense: AGPL-3.0-only\nmetadata:\n  owner: example"))).toEqual([]);
  });

  it("names each problem", () => {
    expect(skillProblems("run-locally", skill("name: Run_Locally\ndescription: x"))).toEqual([
      'name "Run_Locally" must match its folder "run-locally"',
      'name "Run_Locally" must be lowercase letters, digits and single hyphens',
    ]);
    expect(skillProblems("a", skill("name: a\ndescription: x\nmodel: fast"))).toEqual([
      'frontmatter field "model" isn\'t in the skills spec (allowed: name, description, license, compatibility, metadata, allowed-tools)',
    ]);
    expect(skillProblems("a", skill("name: a"))).toEqual(["description is missing"]);
    expect(skillProblems("a", skill(`name: a\ndescription: ${"x".repeat(1025)}`))).toEqual(["description is 1025 characters (1024 at most)"]);
    const long = "a".repeat(65);
    expect(skillProblems(long, skill(`name: ${long}\ndescription: x`))).toEqual(["name is 65 characters (64 at most)"]);
    expect(skillProblems("a", skill("- name\n- description"))).toEqual(["frontmatter must be a set of fields"]);
    expect(skillProblems("a", skill("name: a\ndescription: x\nallowed-tools: [Bash]"))).toEqual(["allowed-tools must be text"]);
  });
});

describe("lineCount", () => {
  it("doesn't count a final newline", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("environment variables", () => {
  it("finds the variables code reads, not the ones comments mention", () => {
    const code = [
      'const on = process.env.MY_FEATURE_ENABLED === "true";',
      'const key = process.env["GEMINI_API_KEY"];',
      "// process.env.IN_A_COMMENT",
      " * `process.env.IN_JSDOC`",
      "const port = process.env.PORT; // process.env.AFTER_CODE",
      'const url = "https://x.test" + process.env.ORIGIN;',
    ].join("\n");
    expect(envReads(code)).toEqual(["MY_FEATURE_ENABLED", "GEMINI_API_KEY", "PORT", "ORIGIN"]);
  });

  it("counts a name .env.example sets, comments out or mentions", () => {
    const names = envDocumented("A_KEY=\n# B_KEY=default\n# Set by the app: C_KEY, D_KEY.\nPRODUCT_MAP_LOCATION_US/_EU");
    for (const n of ["A_KEY", "B_KEY", "C_KEY", "D_KEY", "PRODUCT_MAP_LOCATION_US"]) expect(names.has(n)).toBe(true);
    expect(names.has("PRODUCT_MAP_LOCATION")).toBe(false);
  });

  it("scans code in src, scripts and workers, but not tests or dependencies", () => {
    expect(isEnvSourceFile("src/lib/email/flags.ts")).toBe(true);
    expect(isEnvSourceFile("scripts/local.mjs")).toBe(true);
    expect(isEnvSourceFile("workers/knowledge-scraper/src/index.ts")).toBe(true);
    expect(isEnvSourceFile("src/lib/email/flags.test.ts")).toBe(false);
    expect(isEnvSourceFile("scripts/selfhost/testing/fake-cloud.mjs")).toBe(false);
    expect(isEnvSourceFile("workers/knowledge-scraper/node_modules/x/index.js")).toBe(false);
    expect(isEnvSourceFile("sdk/node/src/index.ts")).toBe(false);
    expect(isEnvSourceFile("src/app/page.md")).toBe(false);
  });
});
