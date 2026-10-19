// Shared settings for `npm run doctor` and `npm run local`.
// Node built-ins only: doctor imports this before `npm install` has run.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LOCAL_DIR = join(REPO_ROOT, ".local");
export const ENV_LOCAL = join(REPO_ROOT, ".env.local");
export const ENV_TEMPLATE = join(REPO_ROOT, "scripts", "local-env.template");

/** The emulator-only project. Firebase treats any `demo-*` id as offline: nothing reaches Google. */
export const LOCAL_PROJECT_ID = "demo-yougrow";
/** First line of a settings file that `npm run local` wrote and may add keys to. */
export const LOCAL_MARKER = "# Written by npm run local.";
export const SEED_ADMIN_EMAIL = "admin@example.com";
export const SEED_TENANT_ID = "ten_demo";

/** The firebase-tools version `npm run local` fetches with npx when no recent global CLI exists. */
export const PINNED_FIREBASE_TOOLS = "15.27.0";
export const MIN_FIREBASE_MAJOR = 14;
export const MIN_JAVA_MAJOR = 21;

/** Every port a local run needs, with the env var that moves it. */
export const PORT_SPECS = [
  { id: "app", env: "LOCAL_APP_PORT", fallback: 3002, label: "app" },
  { id: "firestore", env: "LOCAL_FIRESTORE_PORT", fallback: 8080, label: "Firestore emulator" },
  { id: "auth", env: "LOCAL_AUTH_PORT", fallback: 9099, label: "Auth emulator" },
  { id: "ui", env: "LOCAL_UI_PORT", fallback: 4000, label: "emulator UI" },
  { id: "hub", env: "LOCAL_HUB_PORT", fallback: 4400, label: "emulator hub" },
  { id: "logging", env: "LOCAL_LOGGING_PORT", fallback: 4500, label: "emulator logging" },
  { id: "firestoreWs", env: "LOCAL_FIRESTORE_WS_PORT", fallback: 9150, label: "Firestore UI websocket" },
];

/** Resolved ports, e.g. { app: 3002, firestore: 8080, ... }. Throws on a bad override. */
export function localPorts(env = process.env) {
  const out = {};
  for (const spec of PORT_SPECS) {
    const raw = (env[spec.env] || "").trim();
    if (!raw) {
      out[spec.id] = spec.fallback;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`${spec.env}=${raw} is not a port number (1 to 65535).`);
    }
    out[spec.id] = n;
  }
  return out;
}

/**
 * Values that make the app talk to the local emulators. A local run always sets
 * these, so a .env.local that points at a real project can't leak into it.
 */
export function emulatorRunEnv(ports) {
  return {
    GOOGLE_CLOUD_PROJECT: LOCAL_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: LOCAL_PROJECT_ID,
    // The Auth emulator accepts any key; these only replace a real project's web config.
    NEXT_PUBLIC_FIREBASE_API_KEY: "emulator",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${LOCAL_PROJECT_ID}.firebaseapp.com`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
  };
}

/** True when something accepts connections on the port (IPv4 or IPv6 loopback). */
export async function portInUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (used) => {
        socket.destroy();
        resolve(used);
      };
      socket.setTimeout(400, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  const [v4, v6] = await Promise.all([probe("127.0.0.1"), probe("::1")]);
  return v4 || v6;
}

/** Parse a dotenv file into { KEY: value } (no expansion; surrounding quotes removed). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

/** The state of .env.local: missing, written by npm run local (marked), or someone else's. */
export function readLocalSettings() {
  if (!existsSync(ENV_LOCAL)) return { state: "missing", values: {} };
  const text = readFileSync(ENV_LOCAL, "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  return { state: firstLine === LOCAL_MARKER ? "marked" : "unmarked", values: parseEnvFile(text), text };
}

/**
 * Feature switches for a local run: every `*_ENABLED` switch apphosting.yaml lists
 * (it lists every switch the code reads, off), turned on, except the ones below.
 */
export const SWITCHES_KEPT_OFF = {
  RECAPTCHA_ENABLED: "needs a real reCAPTCHA Enterprise key and project; with it on, every waitlist sign-up is refused",
};

export function featureSwitchNames() {
  const yaml = readFileSync(join(REPO_ROOT, "apphosting.yaml"), "utf8");
  const names = new Set();
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*variable:\s*([A-Z0-9_]+_ENABLED)\s*$/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/** `major.minor.patch` → major, or null. */
function majorOf(version) {
  const m = String(version || "").match(/(\d+)\.\d+/);
  return m ? Number(m[1]) : null;
}

/** The global firebase CLI version, or null when it isn't installed. */
export function globalFirebaseVersion() {
  try {
    const out = execFileSync("firebase", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    });
    const m = out.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** How to run the firebase CLI: the global one when recent enough, else a pinned copy via npx. */
export function firebaseCommand() {
  const version = globalFirebaseVersion();
  const major = majorOf(version);
  if (major !== null && major >= MIN_FIREBASE_MAJOR) {
    return { cmd: "firebase", prefix: [], version, source: "global" };
  }
  return { cmd: "npx", prefix: ["-y", `firebase-tools@${PINNED_FIREBASE_TOOLS}`], version: PINNED_FIREBASE_TOOLS, source: "npx" };
}

/**
 * The Java major version on PATH, or null. Handles both version styles:
 * `openjdk version "21.0.2"` and the old `java version "1.8.0_402"`.
 */
export function javaMajorVersion() {
  // `java -version` writes to stderr. The macOS stub without a JDK exits non zero.
  const r = spawnSync("java", ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return parseJavaMajor(`${r.stderr || ""}\n${r.stdout || ""}`);
}

export function parseJavaMajor(text) {
  const m = String(text || "").match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}
