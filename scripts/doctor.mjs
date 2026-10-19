#!/usr/bin/env node
// npm run doctor: checks this machine can run YouGrow locally and says what to fix.
// Node built-ins only, so it works before `npm install`. No network.
//
//   npm run doctor               one line per check, with a fix for each problem
//   npm run doctor -- --brief    one summary line plus failures (for agent start hooks)
//   npm run doctor -- --json     [{ id, ok, level, message, fix }] for tools
//   npm run doctor -- --cloud    also run the Google Cloud checks (see CLOUD_CHECKS)
//
// Exit code 1 when any check fails.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ENV_LOCAL,
  LOCAL_PROJECT_ID,
  MIN_FIREBASE_MAJOR,
  MIN_JAVA_MAJOR,
  PINNED_FIREBASE_TOOLS,
  PORT_SPECS,
  REPO_ROOT,
  globalFirebaseVersion,
  javaMajorVersion,
  localPorts,
  portInUse,
  readLocalSettings,
} from "./lib/local-env.mjs";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const brief = args.has("--brief");
const withCloud = args.has("--cloud");

const RECOMMENDED_NODE = 24;
const MIN_NODE = 20;
const platform = process.platform;

/** Pick the hint for this OS; show both where the OS is neither macOS nor Linux. */
function byOs(mac, linux) {
  if (platform === "darwin") return mac;
  if (platform === "linux") return linux;
  return `macOS: ${mac}. Linux: ${linux}`;
}

const pass = (id, message) => ({ id, ok: true, level: "info", message, fix: "" });
const problem = (id, level, message, fix) => ({ id, ok: false, level, message, fix });

function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  const fix = `nvm install ${RECOMMENDED_NODE} && nvm use ${RECOMMENDED_NODE} (or install Node ${RECOMMENDED_NODE} from https://nodejs.org)`;
  if (major < MIN_NODE) return problem("node", "fail", `Node ${version} is too old. YouGrow needs Node ${MIN_NODE} or newer (${RECOMMENDED_NODE} recommended).`, fix);
  if (major < RECOMMENDED_NODE) return problem("node", "warn", `Node ${version} works, but ${RECOMMENDED_NODE} is recommended (.nvmrc).`, fix);
  return pass("node", `Node ${version}`);
}

function checkDependencies() {
  if (existsSync(join(REPO_ROOT, "node_modules", "next", "package.json"))) return pass("dependencies", "Dependencies installed");
  return problem("dependencies", "warn", "Dependencies are not installed yet.", "npm install");
}

function checkJava() {
  const major = javaMajorVersion();
  const fix = byOs(
    `brew install openjdk@${MIN_JAVA_MAJOR} && export PATH="$(brew --prefix openjdk@${MIN_JAVA_MAJOR})/bin:$PATH"`,
    `sudo apt-get install -y openjdk-${MIN_JAVA_MAJOR}-jre-headless (Debian or Ubuntu; elsewhere install your distro's OpenJDK ${MIN_JAVA_MAJOR} package)`,
  );
  if (major === null) return problem("java", "fail", `Java not found. The Firebase emulators need Java ${MIN_JAVA_MAJOR} or newer.`, fix);
  if (major < MIN_JAVA_MAJOR) return problem("java", "fail", `Java ${major} found. The Firebase emulators need Java ${MIN_JAVA_MAJOR} or newer.`, fix);
  return pass("java", `Java ${major}`);
}

function checkFirebaseCli() {
  const version = globalFirebaseVersion();
  const major = version ? Number(version.split(".")[0]) : null;
  if (major !== null && major >= MIN_FIREBASE_MAJOR) return pass("firebase-cli", `Firebase CLI ${version}`);
  const found = version ? `Firebase CLI ${version} is older than ${MIN_FIREBASE_MAJOR}` : "No Firebase CLI on PATH";
  return problem(
    "firebase-cli",
    "info",
    `${found}. npm run local will fetch firebase-tools ${PINNED_FIREBASE_TOOLS} with npx (needs the network the first time).`,
    "optional: npm install -g firebase-tools",
  );
}

async function checkPorts() {
  let ports;
  try {
    ports = localPorts();
  } catch (err) {
    return [problem("ports", "fail", err.message, "unset it or use a free port number")];
  }
  const results = await Promise.all(PORT_SPECS.map(async (spec) => ({ spec, port: ports[spec.id], used: await portInUse(ports[spec.id]) })));
  const busy = results.filter((r) => r.used);
  if (!busy.length) return [pass("ports", `Ports free: ${results.map((r) => r.port).join(", ")}`)];
  return busy.map(({ spec, port }) =>
    problem(
      `port-${spec.id}`,
      "fail",
      `Port ${port} (${spec.label}) is in use.`,
      `stop what is using it (see: lsof -nP -iTCP:${port} -sTCP:LISTEN), or move it: ${spec.env}=<free port> npm run local`,
    ),
  );
}

function checkSettings() {
  const settings = readLocalSettings();
  if (settings.state === "missing") return pass("settings", "No .env.local yet. npm run local writes one for the emulators.");
  if (settings.state === "unmarked") {
    return problem(
      "settings",
      "warn",
      ".env.local was not written by npm run local, so it is left as is. npm run local still runs on demo-yougrow and the emulators, but your file's other values apply.",
      "to let npm run local write its own: mv .env.local .env.local.backup",
    );
  }
  const project = settings.values.GOOGLE_CLOUD_PROJECT || "";
  if (project !== LOCAL_PROJECT_ID) {
    return problem("settings", "warn", `.env.local sets GOOGLE_CLOUD_PROJECT=${project || "(empty)"}. npm run local still uses ${LOCAL_PROJECT_ID}.`, `set GOOGLE_CLOUD_PROJECT=${LOCAL_PROJECT_ID} in .env.local`);
  }
  return pass("settings", `.env.local is in local mode (${LOCAL_PROJECT_ID}, emulators)`);
}

function checkGemini() {
  const settings = readLocalSettings();
  const key = process.env.GEMINI_API_KEY || settings.values.GEMINI_API_KEY;
  if (key) return pass("gemini", "Gemini key set: AI writing, images and knowledge search are on");
  return problem(
    "gemini",
    "info",
    "No Gemini key: AI writing, images and knowledge search are off. Everything else works.",
    `optional: get a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY in ${existsSync(ENV_LOCAL) ? ".env.local" : ".env.local (npm run local creates it)"}`,
  );
}

/**
 * Google Cloud checks for `--cloud` (gcloud login, project, APIs, billing...).
 * Extension point: each entry is `async () => result | result[]` built with
 * pass()/problem(). Empty until the self-host checks land.
 */
const CLOUD_CHECKS = [];

async function runChecks() {
  const results = [checkNode(), checkDependencies(), checkJava(), checkFirebaseCli(), ...(await checkPorts()), checkSettings(), checkGemini()];
  if (withCloud) {
    if (!CLOUD_CHECKS.length) results.push(problem("cloud", "info", "Cloud checks are not available yet. This run checked the local setup only.", ""));
    for (const check of CLOUD_CHECKS) results.push(...[].concat(await check()));
  }
  return results;
}

function summary(results) {
  const failed = results.filter((r) => r.level === "fail").length;
  const warned = results.filter((r) => r.level === "warn").length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return { failed, text: `${plural(failed, "failed check")}, ${plural(warned, "warning")}` };
}

function printLine(r) {
  const tag = r.ok ? "ok" : r.level;
  console.log(`${tag.padEnd(5)} ${r.message}`);
  if (!r.ok && r.fix) console.log(`      fix: ${r.fix}`);
}

const results = await runChecks();
const { failed, text } = summary(results);

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else if (brief) {
  console.log(failed ? `doctor: ${text}. Run npm run doctor for details.` : `doctor: ready (${text}).`);
  for (const r of results.filter((x) => x.level === "fail")) printLine(r);
} else {
  console.log("YouGrow doctor");
  for (const r of results) printLine(r);
  console.log(failed ? `Summary: ${text}. Fix the failed checks, then run npm run doctor again.` : `Summary: ${text}. Next: npm run local`);
}

process.exit(failed ? 1 : 0);
