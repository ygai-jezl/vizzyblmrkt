// A deployment's apphosting.<env>.yaml: read it, write it, and add to it without touching
// what its owner changed. Only the shape App Hosting env files use is understood:
//
//   env:
//     - variable: NAME
//       value: "..."            (or: secret: secret-name)
//       availability:
//         - BUILD
//         - RUNTIME
//
// Node built-ins only.

import { CORE_SECRETS, KEPT_OFF, WEB_API_KEY_SECRET } from "./spec.mjs";

export const RUNTIME = ["RUNTIME"];
export const BUILD_RUNTIME = ["BUILD", "RUNTIME"];

/**
 * @typedef {{ name: string, value?: string, secret?: string, availability: string[] }} Entry
 */

/** A value entry. */
export const valueEntry = (name, value, availability = RUNTIME) => ({ name, value: String(value), availability });
/** A secret entry (the secret's name in Secret Manager, never its value). */
export const secretEntry = (name, secret, availability = RUNTIME) => ({ name, secret, availability });

function unquote(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "");
}

/**
 * The env entries of an apphosting*.yaml text, in file order, with the line range each
 * occupies (so one can be replaced in place).
 * @param {string} text
 * @returns {Array<Entry & { start: number, end: number }>}
 */
export function parseEntries(text) {
  const lines = String(text).split("\n");
  /** @type {Array<Entry & { start: number, end: number }>} */
  const out = [];
  let current = null;
  let inAvailability = false;
  const close = (i) => {
    if (current) {
      current.end = i;
      out.push(current);
    }
    current = null;
    inAvailability = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.match(/^(\s*)-\s+variable:\s*(\S+)\s*$/);
    if (start) {
      close(i);
      current = { name: unquote(start[2]), availability: [], start: i, end: i + 1 };
      continue;
    }
    if (!current) continue;
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\S/.test(line)) {
      close(i);
      continue;
    }
    const kv = line.match(/^\s+(value|secret|availability):\s*(.*)$/);
    if (kv) {
      inAvailability = kv[1] === "availability";
      if (kv[1] === "value") current.value = unquote(kv[2]);
      if (kv[1] === "secret") current.secret = unquote(kv[2]);
      continue;
    }
    const item = line.match(/^\s+-\s+([A-Z]+)\s*$/);
    if (item && inAvailability) {
      current.availability.push(item[1]);
      continue;
    }
    // Any other key belonging to this entry: keep it inside the entry's range.
  }
  close(lines.length);
  return out;
}

/** The entries as a Map by name (the last one wins, as in App Hosting). */
export function entryMap(text) {
  return new Map(parseEntries(text).map((e) => [e.name, e]));
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

/** One entry as YAML lines (two-space list indent, as in apphosting.yaml). */
export function formatEntry(entry) {
  const lines = [`  - variable: ${entry.name}`];
  if (entry.secret !== undefined) lines.push(`    secret: ${entry.secret}`);
  else lines.push(`    value: ${yamlScalar(entry.value ?? "")}`);
  lines.push("    availability:");
  for (const a of entry.availability.length ? entry.availability : RUNTIME) lines.push(`      - ${a}`);
  return lines.join("\n");
}

/** True when two entries give the backend the same thing. */
export function sameEntry(a, b) {
  return (a.value ?? null) === (b.value ?? null) && (a.secret ?? null) === (b.secret ?? null) && [...a.availability].sort().join() === [...b.availability].sort().join();
}

/**
 * The switches apphosting.yaml lists (every entry whose value is "false"), with availability.
 * @param {string} baseText
 */
export function baseSwitches(baseText) {
  return parseEntries(baseText)
    .filter((e) => e.value === "false" && e.secret === undefined)
    .map((e) => ({ name: e.name, availability: e.availability.length ? e.availability : BUILD_RUNTIME }));
}

/**
 * What a new deployment's env file holds, as titled sections. A value that isn't known yet
 * (undefined) is left out; a later run adds it.
 * @param {{ project: string, appUrl?: string, authDomain?: string, adminEmail?: string,
 *           tenantId?: string, region?: string, privacyUrl?: string, assetBucket?: string,
 *           signingKey?: string, switches: { name: string, availability: string[] }[] }} v
 */
export function coreSections(v) {
  const maybe = (cond, entry) => (cond ? [entry] : []);
  return [
    {
      title: "Project and sign-in",
      entries: [
        valueEntry("GOOGLE_CLOUD_PROJECT", v.project),
        valueEntry("NEXT_PUBLIC_FIREBASE_PROJECT_ID", v.project, BUILD_RUNTIME),
        valueEntry("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", v.authDomain || `${v.project}.firebaseapp.com`, BUILD_RUNTIME),
        secretEntry(WEB_API_KEY_SECRET.env, WEB_API_KEY_SECRET.name, BUILD_RUNTIME),
        ...maybe(v.adminEmail, valueEntry("ADMIN_ALLOWED_EMAILS", v.adminEmail)),
        ...maybe(v.tenantId, valueEntry("ADMIN_BOOTSTRAP_TENANT_ID", v.tenantId)),
        ...maybe(v.tenantId, valueEntry("ADMIN_BOOTSTRAP_REGION", v.region || "us")),
      ],
    },
    {
      title: "Addresses (your backend's URL; change all three if you add a custom domain)",
      entries: [
        ...maybe(v.appUrl, valueEntry("NEXT_PUBLIC_PLATFORM_ORIGIN", v.appUrl, BUILD_RUNTIME)),
        ...maybe(v.appUrl, valueEntry("EMAIL_LINK_ORIGIN", v.appUrl)),
        ...maybe(v.appUrl, valueEntry("CONNECT_ISSUER", v.appUrl)),
      ],
    },
    {
      title: "Email (no provider yet, so emails are written to the log: npm run selfhost -- --apply addon:email)",
      entries: [...maybe(v.privacyUrl, valueEntry("EMAIL_DEFAULT_PRIVACY_URL", v.privacyUrl))],
    },
    {
      title: "Storage, keys and scheduled work (secrets are names in Secret Manager, never values)",
      entries: [
        ...maybe(v.assetBucket, valueEntry("EMAIL_ASSET_BUCKET", v.assetBucket)),
        ...maybe(v.signingKey, valueEntry("CONNECT_SIGNING_KMS_KEY", v.signingKey)),
        ...CORE_SECRETS.map((s) => secretEntry(s.env, s.name)),
      ],
    },
    {
      title: "Feature switches: on, except the ones listed at the top of this file",
      entries: v.switches.filter((s) => !(s.name in KEPT_OFF)).map((s) => valueEntry(s.name, "true", s.availability)),
    },
  ];
}

/** The header of a new env file. */
export function header({ project, envName }) {
  const kept = Object.entries(KEPT_OFF).map(([name, k]) => `#   ${name}: ${k.why}${k.addon ? ` (addon:${k.addon})` : ""}`);
  return [
    `# App Hosting settings for this deployment of YouGrow: project ${project}, environment "${envName}".`,
    "#",
    `# Written by npm run selfhost. App Hosting merges this file over apphosting.yaml at build time`,
    `# when the backend's environment name is "${envName}" (App Hosting, your backend, Settings,`,
    "# Environment). An entry here replaces the entry in apphosting.yaml with the same variable.",
    "# https://firebase.google.com/docs/app-hosting/multiple-environments",
    "#",
    "# Edit it freely. npm run selfhost only adds entries that are missing and never changes one",
    "# you set; an add-on changes only the entries it is about. Secrets are referenced by name;",
    "# their values live in Secret Manager. New switches from upstream arrive off (apphosting.yaml).",
    "#",
    "# Left off (turn on with the add-on named, or by hand by setting it to \"true\" here):",
    ...kept,
    "",
    "env:",
  ].join("\n");
}

/**
 * A whole new env file.
 * @param {{ project: string, envName: string }} meta
 * @param {{ title: string, entries: Entry[] }[]} sections
 */
export function renderEnvFile(meta, sections) {
  const parts = [header(meta)];
  for (const section of sections) {
    if (!section.entries.length) continue;
    parts.push(`\n  # ===== ${section.title} =====`);
    for (const e of section.entries) parts.push(formatEntry(e));
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Add the entries `text` doesn't have yet, appended at the end of its env list. Existing
 * entries are never changed; ones that differ from what was wanted are reported.
 * @param {string} text
 * @param {Entry[]} wanted
 * @param {string} [note] a comment line for the appended block
 * @returns {{ text: string, added: string[], differs: { name: string, have: Entry, want: Entry }[] }}
 */
export function addMissing(text, wanted, note = "") {
  const have = entryMap(text);
  const missing = wanted.filter((e) => !have.has(e.name));
  const differs = wanted.filter((e) => have.has(e.name) && !sameEntry(/** @type {Entry} */ (have.get(e.name)), e)).map((e) => ({ name: e.name, have: /** @type {Entry} */ (have.get(e.name)), want: e }));
  if (!missing.length) return { text, added: [], differs };
  let body = String(text);
  if (!/^env:\s*$/m.test(body)) body = `${body.replace(/\n*$/, "\n")}\nenv:\n`;
  const block = [note ? `\n  # ${note}` : "", ...missing.map(formatEntry)].filter(Boolean).join("\n");
  return { text: `${body.replace(/\n*$/, "\n")}${block}\n`, added: missing.map((e) => e.name), differs };
}

/**
 * Set entries: replace each existing one in place, append the rest. For an add-on, which owns
 * the entries it is about.
 * @param {string} text
 * @param {Entry[]} entries
 * @param {string} [note]
 * @returns {{ text: string, changed: string[] }}
 */
export function setEntries(text, entries, note = "") {
  let lines = String(text).split("\n");
  const changed = [];
  const toAppend = [];
  for (const entry of entries) {
    const found = parseEntries(lines.join("\n")).filter((e) => e.name === entry.name);
    if (!found.length) {
      toAppend.push(entry);
      changed.push(entry.name);
      continue;
    }
    const last = found[found.length - 1];
    if (sameEntry(last, entry)) continue;
    lines = [...lines.slice(0, last.start), ...formatEntry(entry).split("\n"), ...lines.slice(last.end)];
    changed.push(entry.name);
  }
  let out = lines.join("\n");
  if (toAppend.length) out = addMissing(out, toAppend, note).text;
  return { text: out, changed };
}
