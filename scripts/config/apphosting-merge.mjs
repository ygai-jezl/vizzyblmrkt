// How Firebase App Hosting builds one backend's settings from apphosting.yaml and
// apphosting.<env>.yaml. Pure functions over parsed YAML (no file or git access),
// so the merge rules can be tested on their own.
//
// The rules (https://firebase.google.com/docs/app-hosting/configure):
//   - apphosting.yaml is the base. apphosting.<env>.yaml, when it exists, is merged over it.
//   - env entries merge by `variable`: an overlay entry replaces the base entry of the same
//     name as a whole (value or secret, and availability). Base only entries are inherited.
//   - runConfig merges key by key; the overlay wins.
//   - an entry with no availability is available at BUILD and RUNTIME.

/**
 * @typedef {{ runConfig?: Record<string, unknown>, env?: Array<Record<string, unknown>> }} ApphostingDoc
 *   One parsed apphosting*.yaml file.
 * @typedef {{ availability: string[], source?: "base" | "overlay", [key: string]: unknown }} EnvEntry
 *   One env entry as the backend gets it (value or secret, availability, any other keys).
 * @typedef {{ runConfig: Record<string, unknown>, env: Map<string, EnvEntry>, warnings: string[] }} Resolved
 * @typedef {{ kind: "added" | "removed" | "changed", key: string, before?: string | null, after?: string | null }} Change
 */

export const DEFAULT_AVAILABILITY = ["BUILD", "RUNTIME"];

/**
 * Env entries of one parsed file, keyed by variable name. Later duplicates win and are
 * reported, so a typo that defines a name twice shows up instead of hiding.
 */
/**
 * @param {ApphostingDoc | null | undefined} doc
 * @param {string} [label]
 * @returns {{ entries: Map<string, EnvEntry>, duplicates: string[] }}
 */
export function envEntries(doc, label = "file") {
  const out = new Map();
  const duplicates = [];
  const list = doc && Array.isArray(doc.env) ? doc.env : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || typeof raw.variable !== "string") {
      throw new Error(`${label}: every env entry needs a "variable" name (got ${JSON.stringify(raw)})`);
    }
    if (out.has(raw.variable)) duplicates.push(raw.variable);
    out.set(raw.variable, normaliseEntry(raw));
  }
  return { entries: out, duplicates };
}

/**
 * One env entry as App Hosting sees it: availability filled in and sorted, other keys kept.
 * @param {Record<string, unknown>} raw
 * @returns {EnvEntry}
 */
export function normaliseEntry(raw) {
  /** @type {Record<string, unknown>} */
  const entry = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "variable") continue;
    entry[key] = val;
  }
  const availability = Array.isArray(raw.availability) && raw.availability.length > 0 ? raw.availability : DEFAULT_AVAILABILITY;
  entry.availability = [...new Set(availability.map(String))].sort();
  return /** @type {EnvEntry} */ (entry);
}

/**
 * The settings one backend gets. `overlay` is null when apphosting.<env>.yaml doesn't exist
 * (our dev backend today). Returns { runConfig, env, warnings } with env as a Map sorted by
 * name, each entry tagged with the file it came from.
 * @param {ApphostingDoc | null | undefined} base
 * @param {ApphostingDoc | null} [overlay]
 * @returns {Resolved}
 */
export function mergeApphosting(base, overlay = null) {
  const warnings = [];
  const baseEnv = envEntries(base, "base");
  for (const name of baseEnv.duplicates) warnings.push(`base defines ${name} more than once; the last one is used`);

  const merged = new Map();
  for (const [name, entry] of baseEnv.entries) merged.set(name, { ...entry, source: "base" });

  if (overlay) {
    const overlayEnv = envEntries(overlay, "overlay");
    for (const name of overlayEnv.duplicates) warnings.push(`overlay defines ${name} more than once; the last one is used`);
    for (const [name, entry] of overlayEnv.entries) merged.set(name, { ...entry, source: "overlay" });
  }

  for (const [name, entry] of merged) {
    const hasValue = Object.prototype.hasOwnProperty.call(entry, "value");
    const hasSecret = Object.prototype.hasOwnProperty.call(entry, "secret");
    if (hasValue && hasSecret) warnings.push(`${name} has both a value and a secret`);
    if (!hasValue && !hasSecret) warnings.push(`${name} has neither a value nor a secret`);
  }

  const runConfig = { ...(base?.runConfig ?? {}), ...(overlay?.runConfig ?? {}) };
  const env = new Map([...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { runConfig: sortKeys(runConfig), env, warnings };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Key order inside one printed entry: value or secret first, then availability, then anything else. */
function entryKeys(entry) {
  const first = ["value", "secret", "availability"];
  const rest = Object.keys(entry)
    .filter((k) => k !== "source" && !first.includes(k))
    .sort();
  return [...first.filter((k) => Object.prototype.hasOwnProperty.call(entry, k)), ...rest];
}

/**
 * One entry as a single stable line, without the file it came from.
 * @param {string} name
 * @param {EnvEntry} entry
 */
export function formatEntry(name, entry) {
  const parts = entryKeys(entry).map((key) => {
    const val = entry[key];
    if (key === "availability") return `availability=${val.join(",")}`;
    return `${key}=${JSON.stringify(val)}`;
  });
  return `${name} ${parts.join(" ")}`;
}

/**
 * Stable text: runConfig lines, then one line per variable, sorted.
 * @param {Resolved} resolved
 */
export function formatResolved(resolved) {
  const lines = [];
  for (const [key, val] of Object.entries(resolved.runConfig)) lines.push(`runConfig.${key}=${JSON.stringify(val)}`);
  for (const [name, entry] of resolved.env) lines.push(formatEntry(name, entry));
  return lines.join("\n");
}

/**
 * Plain JSON for --json: runConfig plus env as an object, sources included.
 * @param {Resolved} resolved
 * @returns {{ runConfig: Record<string, unknown>, env: Record<string, Record<string, unknown>> }}
 */
export function toJson(resolved) {
  /** @type {Record<string, Record<string, unknown>>} */
  const env = {};
  for (const [name, entry] of resolved.env) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of entryKeys(entry)) out[key] = entry[key];
    out.source = entry.source;
    env[name] = out;
  }
  return { runConfig: resolved.runConfig, env };
}

/**
 * What changed between two resolved settings, ignoring which file an entry lives in
 * (moving a variable between files is not a change to what the backend gets).
 * Each change is { kind: "added" | "removed" | "changed", key, before?, after? }.
 * @param {Resolved} before
 * @param {Resolved} after
 * @returns {Change[]}
 */
export function diffResolved(before, after) {
  /** @type {Change[]} */
  const changes = [];
  const keys = new Set([...Object.keys(before.runConfig), ...Object.keys(after.runConfig)]);
  for (const key of [...keys].sort()) {
    const a = before.runConfig[key];
    const b = after.runConfig[key];
    const label = `runConfig.${key}`;
    if (a === undefined) changes.push({ kind: "added", key: label, after: `${label}=${JSON.stringify(b)}` });
    else if (b === undefined) changes.push({ kind: "removed", key: label, before: `${label}=${JSON.stringify(a)}` });
    else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ kind: "changed", key: label, before: `${label}=${JSON.stringify(a)}`, after: `${label}=${JSON.stringify(b)}` });
    }
  }
  const names = new Set([...before.env.keys(), ...after.env.keys()]);
  for (const name of [...names].sort()) {
    const a = before.env.get(name);
    const b = after.env.get(name);
    const lineA = a ? formatEntry(name, a) : null;
    const lineB = b ? formatEntry(name, b) : null;
    if (!a) changes.push({ kind: "added", key: name, after: lineB });
    else if (!b) changes.push({ kind: "removed", key: name, before: lineA });
    else if (lineA !== lineB) changes.push({ kind: "changed", key: name, before: lineA, after: lineB });
  }
  return changes;
}

/**
 * Changes as text: `+ added`, `- removed`, and `~ changed` with the old and new line.
 * @param {Change[]} changes
 */
export function formatDiff(changes) {
  const lines = [];
  for (const c of changes) {
    if (c.kind === "added") lines.push(`+ ${c.after}`);
    else if (c.kind === "removed") lines.push(`- ${c.before}`);
    else lines.push(`~ ${c.key}`, `    was: ${c.before}`, `    now: ${c.after}`);
  }
  return lines.join("\n");
}
