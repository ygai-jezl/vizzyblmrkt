import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Proves the Enterprise boundary is wired into ESLint (eslint.config.mjs): the rule is on, at
 * error, over the whole repo, and off only in src/ee and the registry. Needs no file in src/ee.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RULE = "import/no-restricted-paths";
const eslint = new ESLint({ cwd: ROOT });

async function ruleFor(file: string): Promise<unknown> {
  const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> } | undefined;
  return config?.rules?.[RULE];
}

describe("the Enterprise boundary in ESLint", () => {
  it.each(["src/lib/plans/limits.ts", "scripts/check-private-paths.mjs", "src/app/layout.tsx", "sdk/node/src/index.ts", "vitest.config.ts"])(
    "bans src/ee in %s",
    async (file) => {
      const rule = await ruleFor(file);
      expect(Array.isArray(rule)).toBe(true);
      const [severity, options] = rule as [unknown, { basePath: string; zones: unknown[] }];
      expect([2, "error"]).toContain(severity);
      expect(options.zones).toEqual([
        { target: "./", from: "./src/ee", message: expect.stringContaining("Only src/lib/enterprise/registry.ts may import from src/ee") },
      ]);
      expect(existsSync(join(options.basePath, "eslint.config.mjs"))).toBe(true);
    },
    30_000,
  );

  it.each(["src/lib/enterprise/registry.ts", "src/ee/sso/index.ts"])(
    "lets %s import from src/ee",
    async (file) => {
      expect(await ruleFor(file)).toBeUndefined();
    },
    30_000,
  );
});
