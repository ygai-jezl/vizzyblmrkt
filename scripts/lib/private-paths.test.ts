import { describe, expect, it } from "vitest";
import { findPrivatePaths } from "./private-paths.mjs";

// The scan of this repo itself is npm run check:private-paths, which CI runs on our public
// repository only: a fork, or our private deployment repo, may hold these files.
describe("findPrivatePaths", () => {
  it("finds each kind of private only file", () => {
    const hits = findPrivatePaths([
      "apphosting.dev.yaml",
      "./apphosting.prod.yaml",
      ".firebaserc",
      "extensions/fsbq-signups-us.env.vizzybl-marketing-prod",
      "ops/runbooks/rollout.md",
      ".github/workflows/yougrow-deploy.yml",
      ".claude/skills/yougrow-release/SKILL.md",
    ]);
    expect(hits.map((h) => h.path)).toEqual([
      ".claude/skills/yougrow-release/SKILL.md",
      ".firebaserc",
      ".github/workflows/yougrow-deploy.yml",
      "apphosting.dev.yaml",
      "apphosting.prod.yaml",
      "extensions/fsbq-signups-us.env.vizzybl-marketing-prod",
      "ops/runbooks/rollout.md",
    ]);
  });

  it("leaves the public files alone", () => {
    expect(
      findPrivatePaths([
        "apphosting.yaml",
        "apphosting.staging.yaml",
        "extensions/fsbq-signups-us.env",
        "extensions/fsbq-signups-us.env.local",
        "src/ops/thing.ts",
        "docs/ops.md",
        ".github/workflows/ci.yml",
        ".claude/skills/other/SKILL.md",
        "sub/.firebaserc",
      ]),
    ).toEqual([]);
  });
});

