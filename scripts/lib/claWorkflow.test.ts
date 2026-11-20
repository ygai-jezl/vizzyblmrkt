import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// .github/workflows/cla.yml runs on pull_request_target: with the base repository's token, on
// pull requests from anyone. These checks keep it from ever running or reading the pull
// request's code, or letting the pull request's text reach a shell.

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

const ROOT = process.cwd();
const FILE = ".github/workflows/cla.yml";
const RUN = 'node scripts/check-cla.mjs --repo "$REPO" --pr "$PR" --summary "$GITHUB_STEP_SUMMARY"';
/** The only expressions the workflow may use: none of them carries text a pull request author writes. */
const EXPRESSIONS = ["github.event.pull_request.number || inputs.pr", "github.token", "github.repository"];

type Step = { uses?: string; run?: string; name?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { if?: string; steps?: Step[]; permissions?: unknown; container?: unknown; services?: unknown; uses?: string };
type Workflow = { on?: Record<string, unknown>; permissions?: unknown; jobs?: Record<string, Job> };

const text = readFileSync(join(ROOT, FILE), "utf8");
const wf = yaml.load(text) as Workflow;
const jobs = Object.values(wf.jobs ?? {});
const steps = jobs.flatMap((j) => j.steps ?? []);

describe("the CLA workflow", () => {
  it("runs only on pull_request_target (to dev and main) and by hand", () => {
    expect(Object.keys(wf.on ?? {}).sort()).toEqual(["pull_request_target", "workflow_dispatch"]);
    expect((wf.on?.pull_request_target as { branches?: string[] }).branches).toEqual(["dev", "main"]);
  });

  it("has a read-only token: contents and pull requests, read only", () => {
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
  });

  it("is one job, on our repository only, with no container, services or called workflow", () => {
    expect(Object.keys(wf.jobs ?? {})).toEqual(["cla"]);
    for (const job of jobs) {
      expect(job.if).toBe("github.repository == 'ygai-jezl/vizzyblmrkt'");
      expect(job.container).toBeUndefined();
      expect(job.services).toBeUndefined();
      expect(job.uses).toBeUndefined();
    }
  });

  it("uses only actions/checkout@v4 and actions/setup-node@v4", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(["actions/checkout@v4", "actions/setup-node@v4"]).toContain(u);
  });

  it("checks out the default branch only, without keeping the token", () => {
    const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(1);
    for (const s of checkouts) {
      expect(s.with?.ref).toBeUndefined();
      expect(s.with?.repository).toBeUndefined();
      expect(s.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("has exactly one run line: the checker, with no ${{ }} and no --trusted-dir", () => {
    const runs = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
    expect(runs).toEqual([RUN]);
    for (const r of runs) {
      expect(r).not.toContain("${{");
      expect(r).not.toContain("--trusted-dir");
    }
  });

  it("never installs packages", () => {
    for (const s of steps) expect(s.run ?? "").not.toMatch(/\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b/);
  });

  it("uses only expressions that carry no text from the pull request", () => {
    const code = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const found = [...code.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!.trim());
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect(EXPRESSIONS, e).toContain(e);
  });

  it("isn't named like a deployment workflow (check:private-paths reserves yougrow-)", () => {
    expect(FILE.split("/").pop()!.startsWith("yougrow-")).toBe(false);
  });
});
