// Thin, read-mostly wrappers around the gcloud and firebase CLIs (and two REST reads with
// gcloud's token), for `npm run selfhost` and `npm run doctor -- --cloud`. Node built-ins only.
//
// Nothing here prints a command's output: callers decide what to show. Secret values only
// ever travel on a child's stdin (`--data-file=-`), never as arguments or in output.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUIET_ENV = { CLOUDSDK_CORE_DISABLE_PROMPTS: "1", NO_UPDATE_NOTIFIER: "1" };

/**
 * Run a command and capture its output. Never throws: { ok, code, stdout, stderr, missing }.
 * `missing` is true when the command itself isn't installed.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, cwd?: string, env?: Record<string, string>, timeoutMs?: number }} [opts]
 */
export function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    input: opts.input,
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, ...QUIET_ENV, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const missing = Boolean(r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT");
  return { ok: !r.error && r.status === 0, code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing };
}

/**
 * Run a command with its output shown live (for long steps such as a deploy). Resolves to the
 * exit code. Use only for commands whose output carries no secret.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<number>}
 */
export function live(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...QUIET_ENV, ...(opts.env ?? {}) }, stdio: ["inherit", "inherit", "inherit"] });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** The last meaningful line of a command's error output, for a one-line reason. */
export function reason(result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Updates are available|To update|WARNING: Python)/.test(l));
  const line = lines.find((l) => /^ERROR|Error:|error:/.test(l)) ?? lines.at(-1) ?? "";
  return line.replace(/^ERROR: \([^)]*\) /, "").slice(0, 300);
}

/** gcloud with --format=json, parsed. { ok, data, result }. */
export function gcloudJson(args) {
  const result = capture("gcloud", [...args, "--format=json"]);
  if (!result.ok) return { ok: false, data: null, result };
  try {
    return { ok: true, data: JSON.parse(result.stdout || "null"), result };
  } catch {
    return { ok: false, data: null, result };
  }
}

/** One gcloud value (--format=value(...)), trimmed. */
export function gcloudValue(args) {
  const result = capture("gcloud", args);
  return { ok: result.ok, value: result.ok ? result.stdout.trim() : "", result };
}

/** firebase with --json, parsed. { ok, data (the "result" field), result }. */
export function firebaseJson(args) {
  const result = capture("firebase", [...args, "--json", "--non-interactive"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "null");
  } catch {
    parsed = null;
  }
  const ok = result.ok && parsed && parsed.status === "success";
  return { ok: Boolean(ok), data: ok ? parsed.result : null, error: parsed && parsed.error ? String(parsed.error) : reason(result), result };
}

/** True when the gcloud CLI is installed. */
export function hasGcloud() {
  return !capture("gcloud", ["--version"], { timeoutMs: 30_000 }).missing;
}

/** True when the firebase CLI is installed. */
export function hasFirebase() {
  return !capture("firebase", ["--version"], { timeoutMs: 30_000 }).missing;
}

/** The active gcloud account, or "". */
export function gcloudAccount() {
  return gcloudValue(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).value.split("\n")[0] ?? "";
}

/** True when Application Default Credentials exist (the workspace and agent steps use them). */
export function hasAdc() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const base = process.env.CLOUDSDK_CONFIG || (process.platform === "win32" ? join(process.env.APPDATA ?? "", "gcloud") : join(homedir(), ".config", "gcloud"));
  return existsSync(join(base, "application_default_credentials.json"));
}

/**
 * The project as gcloud sees it: { state: "ok", projectNumber, name } or { state: "missing" | "error", why }.
 * @param {string} project
 */
export function describeProject(project) {
  const r = gcloudJson(["projects", "describe", project]);
  if (r.ok && r.data) {
    if (r.data.lifecycleState && r.data.lifecycleState !== "ACTIVE") return { state: "error", why: `project ${project} is ${r.data.lifecycleState}` };
    return { state: "ok", projectNumber: String(r.data.projectNumber ?? ""), name: r.data.name ?? project };
  }
  const why = reason(r.result);
  if (/not found|does not exist|may not exist|permission|denied|403|404/i.test(why)) return { state: "missing", why };
  return { state: "error", why };
}

/** { state: "on" | "off" | "unknown", why } for the project's billing. */
export function billingState(project) {
  const r = gcloudValue(["billing", "projects", "describe", project, "--format=value(billingEnabled)"]);
  if (!r.ok) return { state: "unknown", why: reason(r.result) };
  return /^true$/i.test(r.value) ? { state: "on", why: "" } : { state: "off", why: "billing is not enabled" };
}

/** The enabled API ids, or null when they can't be read. */
export function enabledApis(project) {
  const r = gcloudValue(["services", "list", "--enabled", `--project=${project}`, "--format=value(config.name)"]);
  if (!r.ok) return { apis: null, why: reason(r.result) };
  return { apis: new Set(r.value.split("\n").map((s) => s.trim()).filter(Boolean)), why: "" };
}

/** The secret names in the project, or null when they can't be read. */
export function secretNames(project) {
  const r = gcloudValue(["secrets", "list", `--project=${project}`, "--format=value(name.basename())"]);
  if (!r.ok) return { names: null, why: reason(r.result) };
  return { names: new Set(r.value.split("\n").map((s) => s.trim().split("/").pop()).filter(Boolean)), why: "" };
}

/**
 * Create a secret whose value is generated here and sent only on gcloud's stdin.
 * Never prints or returns the value.
 * @param {string} project
 * @param {string} name
 * @param {string} value
 */
export function createSecret(project, name, value) {
  const r = capture("gcloud", ["secrets", "create", name, `--project=${project}`, "--replication-policy=automatic", "--data-file=-"], { input: value });
  return { ok: r.ok, why: r.ok ? "" : reason(r) };
}

/**
 * App Hosting backends: { ok, backends: [{ id, location, uri, environment, repository, serviceAccount }] }.
 * @param {string} project
 */
export function listBackends(project) {
  const r = firebaseJson(["apphosting:backends:list", "--project", project]);
  if (!r.ok) return { ok: false, backends: [], why: r.error };
  const list = Array.isArray(r.data) ? r.data : [];
  return {
    ok: true,
    why: "",
    backends: list.map((b) => {
      const parts = String(b.name ?? "").split("/");
      const uri = String(b.uri ?? "");
      return {
        id: parts.at(-1) ?? "",
        location: parts[3] ?? "",
        uri: uri ? (uri.startsWith("http") ? uri : `https://${uri}`) : "",
        environment: String(b.environment ?? ""),
        repository: String(b.codebase?.repository ?? ""),
        serviceAccount: String(b.serviceAccount ?? ""),
      };
    }),
  };
}

/** Web apps registered in the project's Firebase: { ok, apps: [{ appId, displayName }], notFirebase }. */
export function listWebApps(project) {
  const r = firebaseJson(["apps:list", "WEB", "--project", project]);
  if (!r.ok) {
    const notFirebase = /not.*firebase|Failed to get Firebase project|404|NOT_FOUND|does not exist/i.test(r.error);
    return { ok: false, apps: [], notFirebase, why: r.error };
  }
  const list = Array.isArray(r.data) ? r.data : [];
  return { ok: true, apps: list.map((a) => ({ appId: String(a.appId ?? ""), displayName: String(a.displayName ?? "") })), notFirebase: false, why: "" };
}

/**
 * A web app's config (projectId, authDomain, apiKey...). The caller must not print apiKey.
 * @param {string} project
 * @param {string} appId
 */
export function webAppConfig(project, appId) {
  const r = firebaseJson(["apps:sdkconfig", "WEB", appId, "--project", project]);
  if (!r.ok || !r.data) return { ok: false, config: null, why: r.error };
  const sdk = r.data.sdkConfig ?? r.data;
  return { ok: true, config: sdk, why: "" };
}

/** An access token from gcloud, for a REST read. Kept in memory; never printed. */
function accessToken() {
  const r = capture("gcloud", ["auth", "print-access-token"]);
  return r.ok ? r.stdout.trim() : "";
}

/**
 * A JSON REST call with gcloud's token, billed to `project`.
 * { ok, status, data, why }. Never throws.
 * @param {string} url
 * @param {string} project
 * @param {{ method?: string, body?: unknown }} [opts]
 */
export async function rest(url, project, opts = {}) {
  const token = accessToken();
  if (!token) return { ok: false, status: 0, data: null, why: "gcloud has no access token (run: gcloud auth login)" };
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project, "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const why = res.ok ? "" : (data && data.error && data.error.message) || `HTTP ${res.status}`;
    return { ok: res.ok, status: res.status, data, why: String(why).slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, data: null, why: err instanceof Error ? err.message : String(err) };
  }
}

/** Base URL of the Identity Toolkit admin API (overridable for tests). */
export function identityToolkitBase() {
  return (process.env.SELFHOST_IDENTITY_TOOLKIT_URL || "https://identitytoolkit.googleapis.com").replace(/\/+$/, "");
}

/** Base URL of the Firebase Management API (overridable for tests). */
export function firebaseApiBase() {
  return (process.env.SELFHOST_FIREBASE_URL || "https://firebase.googleapis.com").replace(/\/+$/, "");
}

/** Base URL of the App Hosting API (overridable for tests). */
export function appHostingBase() {
  return (process.env.SELFHOST_APPHOSTING_URL || "https://firebaseapphosting.googleapis.com").replace(/\/+$/, "");
}

/**
 * GET <url>/api/health: { ok, status, why }.
 * @param {string} appUrl
 */
export async function health(appUrl) {
  try {
    const res = await fetch(`${appUrl.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    const body = await res.text();
    let status = "";
    try {
      status = JSON.parse(body).status ?? "";
    } catch {
      status = "";
    }
    if (res.ok && status === "ok") return { ok: true, status: res.status, why: "" };
    return { ok: false, status: res.status, why: `answered HTTP ${res.status}` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err.cause) : null;
    const why = cause ? cause.code || cause.message : err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, why: String(why).split("\n")[0].slice(0, 160) };
  }
}
