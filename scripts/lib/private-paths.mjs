// Files that belong only in our private deployment repo (this public repo plus our
// settings and operations), so `npm run check:private-paths` can keep them out of here.
// Pure functions, Node built-ins only.

import { globToRegExp } from "./instance-values.mjs";

/** Path globs (as in scripts/instance-values.allow) for private only files, each with why. */
export const PRIVATE_PATHS = [
  { glob: "apphosting.dev.yaml", why: "our dev backend's settings" },
  { glob: "apphosting.prod.yaml", why: "our prod backend's settings" },
  { glob: ".firebaserc", why: "our Firebase project aliases" },
  { glob: "extensions/*.env.vizzybl-marketing-*", why: "our per project extension settings" },
  { glob: "ops/**", why: "our operations" },
  { glob: ".github/workflows/yougrow-*", why: "our deployment workflows" },
  { glob: ".claude/skills/yougrow-*/**", why: "our deployment skills" },
].map((p) => ({ ...p, re: globToRegExp(p.glob) }));

/**
 * The paths (repository relative, "/" separated) that are private only, each with the
 * glob that matched and why.
 * @param {Iterable<string>} paths
 * @returns {{ path: string, glob: string, why: string }[]}
 */
export function findPrivatePaths(paths) {
  const hits = [];
  for (const raw of paths) {
    const path = String(raw).replace(/^\.\//, "");
    const match = PRIVATE_PATHS.find((p) => p.re.test(path));
    if (match) hits.push({ path, glob: match.glob, why: match.why });
  }
  return hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
