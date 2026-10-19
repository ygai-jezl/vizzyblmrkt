// What `npm run check:instance` looks for, and how it reads its allowlist. Pure functions,
// Node built-ins only, so the check runs before `npm install` and is easy to test.
//
// "Instance values" name one particular hosted copy of YouGrow (ours): its domains, Google
// Cloud projects, tenants, App Hosting address and Google Analytics id. Code should read
// them from config instead, so anyone can run their own copy. The patterns are written so
// this file never contains a value itself.

/** @type {{ id: string, re: RegExp }[]} */
export const INSTANCE_PATTERNS = [
  { id: "our product domain", re: /yougrow\.ai/ },
  { id: "our sending domain", re: /vizzybl\.ai/ },
  { id: "our Google Cloud project", re: /vizzybl-marketing-(?:dev|prod)/ },
  { id: "our tenant id", re: /ten_(?:vzb|yougrow-ai)/ },
  { id: "an App Hosting backend address", re: /[a-z0-9-]+--[a-z0-9-]+\.[a-z0-9-]+\.hosted\.app/ },
  { id: "a Google Analytics measurement id", re: /\bG-[A-Z0-9]{10}\b/ },
];

/**
 * Every instance value in `text`, one entry per match: { line, column, value, pattern }.
 * Lines and columns count from 1.
 */
export function findInstanceValues(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { id, re } of INSTANCE_PATTERNS) {
      const global = new RegExp(re.source, "g");
      let m;
      while ((m = global.exec(line)) !== null) {
        hits.push({ line: i + 1, column: m.index + 1, value: m[0], pattern: id });
        if (m[0].length === 0) global.lastIndex++;
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * A path glob as a RegExp over repository paths ("/" separated, no leading "./"):
 *   **  any number of directories (also none), *  anything but "/", ?  one character but "/".
 * A glob ending in "/" means everything under that directory.
 */
export function globToRegExp(glob) {
  let g = String(glob).trim().replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The allowlist file: one entry per line, `<glob>  # <why>`. Blank lines and lines that start
 * with "#" are comments. Every entry needs a reason; a line without one is an error, so the
 * list can't quietly grow without saying why.
 */
export function parseAllowList(text) {
  const entries = [];
  const errors = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const at = raw.search(/\s#\s?/);
    const glob = (at === -1 ? raw : raw.slice(0, at)).trim();
    const reason = at === -1 ? "" : raw.slice(at).replace(/^\s#\s?/, "").trim();
    if (!reason) {
      errors.push(`line ${i + 1}: "${glob}" has no reason (write it as: <glob>  # <why it may name our instance>)`);
      continue;
    }
    entries.push({ glob, reason, line: i + 1, re: globToRegExp(glob) });
  }
  return { entries, errors };
}

/** The first allowlist entry that covers `path`, or null. */
export function allowedBy(path, entries) {
  return entries.find((e) => e.re.test(path)) ?? null;
}
