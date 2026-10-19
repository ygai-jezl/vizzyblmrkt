#!/usr/bin/env node
// npm run local: run YouGrow on this laptop with no accounts and no real Google Cloud project.
//
// 1. Writes .env.local from scripts/local-env.template when there is none (or adds missing
//    keys to one it wrote before). A .env.local it did not write is never changed.
// 2. Starts the Firestore and Auth emulators on the offline project demo-yougrow, keeping
//    their data in .local/emulator-data between runs.
// 3. Inside them: seeds the demo brand, starts `next dev`, and calls the scheduled-work
//    routes every 2 minutes (what Cloud Scheduler does when deployed).
//
// Prints a few lines; everything else goes to .local/local.log. Ctrl-C (or SIGTERM)
// stops everything and saves the emulator data.
//
// Ports move with LOCAL_APP_PORT, LOCAL_FIRESTORE_PORT, LOCAL_AUTH_PORT, LOCAL_UI_PORT,
// LOCAL_HUB_PORT, LOCAL_LOGGING_PORT and LOCAL_FIRESTORE_WS_PORT.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ENV_LOCAL,
  ENV_TEMPLATE,
  LOCAL_DIR,
  LOCAL_MARKER,
  LOCAL_PROJECT_ID,
  MIN_JAVA_MAJOR,
  PORT_SPECS,
  REPO_ROOT,
  SEED_ADMIN_EMAIL,
  SEED_TENANT_ID,
  SWITCHES_KEPT_OFF,
  emulatorRunEnv,
  featureSwitchNames,
  firebaseCommand,
  javaMajorVersion,
  localPorts,
  parseEnvFile,
  portInUse,
  readLocalSettings,
} from "./lib/local-env.mjs";

const LOG_FILE = join(LOCAL_DIR, "local.log");
const RUN_FILE = join(LOCAL_DIR, "run.json");
const DATA_DIR_NAME = "emulator-data";
const DATA_DIR = join(LOCAL_DIR, DATA_DIR_NAME);
const EXPORT_METADATA = join(DATA_DIR, "firebase-export-metadata.json");
const FIREBASE_CONFIG_NAME = "firebase.json";
const MARK = "@@local ";
const TICK_MS = 2 * 60 * 1000;
const READY_TIMEOUT_MS = 5 * 60 * 1000;

// The routes Cloud Scheduler calls when deployed (see the setup.sh scripts under infra), with their worker secrets.
const TICK_ROUTES = [
  { name: "journeys", path: "/api/admin/lifecycle/tick", secretEnv: "LIFECYCLE_WORKER_SECRET" },
  { name: "emails", path: "/api/admin/email/jobs/process", secretEnv: "EMAIL_WORKER_SECRET" },
  { name: "scheduled posts", path: "/api/admin/distribute/posts/process", secretEnv: "DISTRIBUTE_WORKER_SECRET" },
];

const secret = () => randomBytes(32).toString("base64url");

if (process.argv.includes("--child")) {
  await child();
} else {
  await parent();
}

// ---------------------------------------------------------------------------
// Parent: settings, emulator config, then supervise `firebase emulators:exec`.
// ---------------------------------------------------------------------------

async function parent() {
  process.stdout.on("error", () => {});
  const say = (line) => console.log(line);
  const stopWith = (message, fix) => {
    say(message);
    if (fix) say(`fix: ${fix}`);
    process.exit(1);
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) stopWith(`Node ${process.versions.node} is too old (YouGrow needs 20 or newer, 24 recommended).`, "npm run doctor");
  if (!existsSync(join(REPO_ROOT, "node_modules", "next", "package.json"))) stopWith("Dependencies are not installed.", "npm install");

  let ports;
  try {
    ports = localPorts();
  } catch (err) {
    stopWith(err.message, "unset it or use a free port number");
  }
  const busy = [];
  for (const spec of PORT_SPECS) if (await portInUse(ports[spec.id])) busy.push(spec);
  if (busy.length) {
    for (const spec of busy) say(`Port ${ports[spec.id]} (${spec.label}) is in use.`);
    stopWith("Nothing was started.", `stop what is using it, or move it, e.g. ${busy[0].env}=<free port> npm run local`);
  }
  const java = javaMajorVersion();
  if (java === null || java < MIN_JAVA_MAJOR) {
    stopWith(`The Firebase emulators need Java ${MIN_JAVA_MAJOR} or newer (${java === null ? "none found" : `found ${java}`}).`, "npm run doctor shows the install command");
  }

  mkdirSync(LOCAL_DIR, { recursive: true });
  const log = createWriteStream(LOG_FILE, { flags: "w" });
  log.write(`npm run local, ${new Date().toISOString()}\nports: ${JSON.stringify(ports)}\n`);

  const settings = prepareSettings(ports);
  writeFileSync(join(LOCAL_DIR, FIREBASE_CONFIG_NAME), `${JSON.stringify(firebaseConfig(ports), null, 2)}\n`);
  // Values the child applies to the app, including secrets: a private file, not the
  // environment, so the firebase CLI never logs them.
  writeFileSync(RUN_FILE, JSON.stringify({ env: settings.forced }), { mode: 0o600 });

  const fb = firebaseCommand();
  const importing = existsSync(EXPORT_METADATA);
  const childScript = [process.execPath, join(REPO_ROOT, "scripts", "local.mjs"), "--child"].map(shellQuote).join(" ");
  const args = [
    ...fb.prefix,
    "emulators:exec",
    "--config",
    FIREBASE_CONFIG_NAME,
    "--project",
    LOCAL_PROJECT_ID,
    "--ui",
    ...(importing ? ["--import", DATA_DIR_NAME] : []),
    "--export-on-exit",
    DATA_DIR_NAME,
    childScript,
  ];
  log.write(`firebase CLI: ${fb.source} ${fb.version}\n$ ${fb.cmd} ${args.join(" ")}\n\n`);

  if (settings.line) say(settings.line);
  say(`Starting the emulators and the app${importing ? "" : " (the first run takes a few minutes)"}. Log: .local/local.log`);

  const startedAt = Date.now();
  const proc = spawn(fb.cmd, args, {
    cwd: LOCAL_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", LOCAL_APP_PORT: String(ports.app) },
  });

  const state = { childPid: null, nextPid: null, emulatorPids: [], ready: false, stopping: false, stopAt: 0, firstTickReported: false, error: null };

  const onLine = (line) => {
    log.write(`${line}\n`);
    if (!line.startsWith(MARK)) return;
    const [kind, ...rest] = line.slice(MARK.length).split(" ");
    const detail = rest.join(" ");
    if (kind === "pid") state.childPid = Number(detail);
    else if (kind === "next-pid") state.nextPid = Number(detail);
    else if (kind === "error") state.error = detail;
    else if (kind === "ready") {
      state.ready = true;
      say(`Emulators running on ${LOCAL_PROJECT_ID}: Firestore 127.0.0.1:${ports.firestore}, Auth 127.0.0.1:${ports.auth}, UI http://127.0.0.1:${ports.ui}`);
      say(`Seeded the demo brand Acme (tenant ${SEED_TENANT_ID}).`);
      say(`Journeys, emails and scheduled posts tick every 2 minutes.`);
      say(`App: http://localhost:${ports.app}`);
      say(`Sign in: click "Sign in with Google", then pick or add ${SEED_ADMIN_EMAIL} on the emulator's test page.`);
      say(`Ctrl-C stops everything and keeps the data.`);
      void rememberEmulatorPids(ports.hub).then((pids) => (state.emulatorPids = pids));
    } else if (kind === "tick" && !state.firstTickReported) {
      // "tick <status> <name...>": only a failed first tick is worth a line here.
      state.firstTickReported = true;
      const status = rest[0];
      if (status !== "200") say(`The first scheduled-work tick failed (${detail}). See .local/local.log.`);
    }
  };
  createInterface({ input: proc.stdout }).on("line", onLine);
  createInterface({ input: proc.stderr }).on("line", onLine);

  const killGroup = (pid, signal) => {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  };
  const forceStop = () => {
    killGroup(proc.pid, "SIGKILL");
    killGroup(state.nextPid, "SIGKILL");
    // The emulators run in their own process groups, so they are stopped one by one.
    for (const pid of state.emulatorPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(RUN_FILE, { force: true });
    say("Forced to stop. The emulator data from this run was not saved.");
    process.exit(1);
  };
  const stop = () => {
    if (state.stopping) {
      // npm passes the same Ctrl-C on a moment later: only a second, later press forces it.
      if (Date.now() - state.stopAt > 1500) forceStop();
      return;
    }
    state.stopping = true;
    state.stopAt = Date.now();
    say("Stopping and saving the emulator data (Ctrl-C again to force)...");
    // Stopping the child script ends `emulators:exec` cleanly, which exports the data.
    if (state.childPid) {
      try {
        process.kill(state.childPid, "SIGTERM");
      } catch {
        killGroup(proc.pid, "SIGINT");
      }
    } else {
      killGroup(proc.pid, "SIGINT");
    }
    setTimeout(forceStop, 120_000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

  const code = await new Promise((resolve) => proc.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0))));
  await new Promise((resolve) => log.end(resolve));
  rmSync(RUN_FILE, { force: true });

  const saved = existsSync(EXPORT_METADATA) && statSync(EXPORT_METADATA).mtimeMs >= startedAt;
  if (state.stopping) {
    say(saved ? "Stopped. Emulator data saved in .local/emulator-data." : "Stopped. The emulator data could not be saved; see .local/local.log.");
    process.exit(0);
  }
  if (!state.ready) {
    say(`The local run stopped before the app was ready${state.error ? `: ${state.error}` : "."}`);
    for (const line of lastLines(LOG_FILE, 12)) say(`  ${line}`);
    say("Full log: .local/local.log. Check your setup with: npm run doctor");
  } else {
    say(`The local run stopped unexpectedly${state.error ? `: ${state.error}` : ""}. See .local/local.log.${saved ? " Emulator data was saved." : ""}`);
  }
  process.exit(code || 1);
}

/**
 * Make sure .env.local suits a local run and work out what the app must be given
 * on top of it. Returns a line to print (or null) and the values to force.
 */
function prepareSettings(ports) {
  const appOrigin = `http://localhost:${ports.app}`;
  const settings = readLocalSettings();
  let line = null;
  let fileValues = settings.values;

  if (settings.state === "missing") {
    const text = renderTemplate(ports);
    writeFileSync(ENV_LOCAL, text, { mode: 0o600 });
    fileValues = parseEnvFile(text);
    line = "Wrote .env.local for a local run: demo-yougrow project, emulators, new local secrets, feature switches on.";
  } else if (settings.state === "marked") {
    const added = addMissingKeys(settings.text, ports);
    if (added.length) {
      const names = added.length <= 4 ? `: ${added.join(", ")}` : "";
      line = `Added ${added.length} new setting${added.length === 1 ? "" : "s"} to .env.local${names}.`;
      fileValues = parseEnvFile(readFileSync(ENV_LOCAL, "utf8"));
    }
  } else {
    line = "Your .env.local was not written by npm run local, so it is left as is. This run sets its own project, emulator, admin and seed values on top.";
  }

  // Always: the emulators this run started, on the offline demo project.
  const forced = { ...emulatorRunEnv(ports), LOCAL_APP_PORT: String(ports.app) };
  if (settings.state === "unmarked") {
    Object.assign(forced, {
      ADMIN_ALLOWED_EMAILS: SEED_ADMIN_EMAIL,
      ADMIN_BOOTSTRAP_TENANT_ID: SEED_TENANT_ID,
      ADMIN_BOOTSTRAP_REGION: "us",
      ALLOW_SEED: "true",
      CANVAS_ALLOW_INSECURE_LOCAL: "1",
      CONNECT_ISSUER: appOrigin,
    });
  }
  // The tick loop and the app must share the worker secrets: the file's, or new ones for this run.
  for (const route of TICK_ROUTES) {
    forced[route.secretEnv] = (settings.state !== "unmarked" && fileValues[route.secretEnv]) || secret();
  }
  return { line, forced };
}

function renderTemplate(ports) {
  const appOrigin = `http://localhost:${ports.app}`;
  const run = emulatorRunEnv(ports);
  const text = readFileSync(ENV_TEMPLATE, "utf8")
    .replaceAll("{{FIRESTORE_HOST}}", run.FIRESTORE_EMULATOR_HOST)
    .replaceAll("{{AUTH_HOST}}", run.FIREBASE_AUTH_EMULATOR_HOST)
    .replaceAll("{{APP_ORIGIN}}", appOrigin)
    .replace(/\{\{SECRET\}\}/g, () => secret())
    .replace("{{FEATURE_SWITCHES}}", featureSwitchBlock());
  if (!text.startsWith(LOCAL_MARKER)) throw new Error(`${ENV_TEMPLATE} must start with "${LOCAL_MARKER}"`);
  return text;
}

function featureSwitchBlock() {
  const names = featureSwitchNames().sort();
  const keptOff = Object.entries(SWITCHES_KEPT_OFF);
  const lines = ["# Feature switches: every *_ENABLED switch apphosting.yaml lists, turned on for a local run."];
  if (keptOff.length) {
    lines.push("# Kept off on a laptop:");
    for (const [name, reason] of keptOff) lines.push(`#   ${name}: ${reason}.`);
  }
  for (const name of names) lines.push(`${name}=${name in SWITCHES_KEPT_OFF ? "false" : "true"}`);
  return lines.join("\n");
}

/** Append template keys the file lacks (new secrets for secret keys). Never changes a value. */
function addMissingKeys(existingText, ports) {
  const existing = parseEnvFile(existingText);
  const missing = [];
  for (const line of renderTemplate(ports).split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && !(m[1] in existing)) missing.push({ key: m[1], line });
  }
  if (!missing.length) return [];
  const block = [`# Added by npm run local on ${new Date().toISOString().slice(0, 10)}`, ...missing.map((x) => x.line)].join("\n");
  writeFileSync(ENV_LOCAL, `${existingText.replace(/\n*$/, "\n")}\n${block}\n`);
  return missing.map((x) => x.key);
}

/**
 * Emulator-only firebase.json: Firestore with the repo's rules, Auth, the UI, and
 * every port this run uses. The emulator takes one rules file for all databases
 * (it doesn't read the per-database list in firebase.json; named databases such as
 * the EU and Asia ones still work).
 */
function firebaseConfig(ports) {
  return {
    firestore: { rules: join(REPO_ROOT, "firestore.rules") },
    emulators: {
      singleProjectMode: true,
      firestore: { host: "127.0.0.1", port: ports.firestore, websocketPort: ports.firestoreWs },
      auth: { host: "127.0.0.1", port: ports.auth },
      ui: { enabled: true, host: "127.0.0.1", port: ports.ui },
      hub: { host: "127.0.0.1", port: ports.hub },
      logging: { host: "127.0.0.1", port: ports.logging },
    },
  };
}

/** The emulators' process ids, from the hub, so a forced stop can end them too. */
async function rememberEmulatorPids(hubPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${hubPort}/emulators`, { signal: AbortSignal.timeout(5000) });
    const info = await res.json();
    return Object.values(info)
      .map((e) => e && e.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function shellQuote(s) {
  if (process.platform === "win32") return `"${s}"`;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function lastLines(file, n) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith(MARK))
      .slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Child: runs inside `firebase emulators:exec`. Seeds, serves, ticks.
// It must exit with a code (never die by a signal), or the emulators skip the export.
// ---------------------------------------------------------------------------

async function child() {
  process.chdir(REPO_ROOT);
  const mark = (line) => console.log(`${MARK}${line}`);
  const { env: forced } = JSON.parse(readFileSync(RUN_FILE, "utf8"));
  const env = { ...process.env, ...forced };
  const port = Number(forced.LOCAL_APP_PORT);
  const base = `http://localhost:${port}`;
  mark(`pid ${process.pid}`);

  let nextProc = null;
  let tickTimer = null;
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    if (tickTimer) clearInterval(tickTimer);
    if (nextProc && nextProc.exitCode === null && nextProc.signalCode === null) {
      try {
        process.kill(-nextProc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const exited = await waitForExit(nextProc, 10_000);
      if (!exited) {
        try {
          process.kill(-nextProc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void shutdown(0));

  // 1. Seed (idempotent; also creates the demo admin in the Auth emulator).
  const tsx = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const seedCode = await run(process.execPath, [tsx, join("scripts", "seed.ts")], env);
  if (stopping) return;
  if (seedCode !== 0) {
    mark(`error seeding failed (exit ${seedCode})`);
    return shutdown(1);
  }
  mark("seeded");

  // 2. The app. Its own process group, so it can be stopped with everything it starts.
  const nextBin = join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
  nextProc = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], { env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  mark(`next-pid ${nextProc.pid}`);
  nextProc.on("exit", (code, signal) => {
    if (stopping) return;
    mark(`error next dev exited (${code ?? signal})`);
    void shutdown(1);
  });
  const healthy = await waitForHealth(`${base}/api/health`, READY_TIMEOUT_MS, () => stopping);
  if (stopping) return;
  if (!healthy) {
    mark(`error the app did not answer on ${base} within ${READY_TIMEOUT_MS / 60000} minutes`);
    return shutdown(1);
  }
  mark("ready");

  // 3. Scheduled work: what Cloud Scheduler calls when deployed, every 2 minutes.
  let ticking = false;
  const tick = async () => {
    if (ticking || stopping) return;
    ticking = true;
    for (const route of TICK_ROUTES) {
      let status = "error";
      let body = "";
      try {
        const res = await fetch(`${base}${route.path}`, {
          method: "POST",
          headers: { "x-worker-secret": forced[route.secretEnv] },
          signal: AbortSignal.timeout(110_000),
        });
        status = String(res.status);
        body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
      } catch (err) {
        body = err instanceof Error ? err.message : String(err);
      }
      mark(`tick ${status} ${route.name} ${body}`);
    }
    ticking = false;
  };
  await tick();
  tickTimer = setInterval(() => void tick(), TICK_MS);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", () => resolve(1));
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

function waitForExit(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForHealth(url, ms, cancelled) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cancelled()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
