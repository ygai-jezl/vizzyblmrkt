#!/usr/bin/env node
// Runs the Firebase emulators with the CLI `npm run local` uses: a global firebase 14 or
// newer, else the pinned firebase-tools through npx. So `npm run smoke` and
// `npm run emulators` work on a machine (or a CI runner) with no Firebase CLI installed.
// Only emulator commands, and only on an offline demo-* project: it can't deploy anything
// or reach a real project.
//
//   node scripts/emulators.mjs exec --config firebase.integration.json --project demo-yougrow 'bash scripts/smoke.sh'
//   node scripts/emulators.mjs start --only firestore,auth --project demo-yougrow

import { spawn } from "node:child_process";
import { MIN_FIREBASE_MAJOR, firebaseCommand } from "./lib/local-env.mjs";

const [action, ...rest] = process.argv.slice(2);
const usage = "usage: node scripts/emulators.mjs <exec|start> --project demo-<name> [firebase emulator options]";
if (action !== "exec" && action !== "start") {
  console.error(usage);
  process.exit(2);
}
const at = rest.indexOf("--project");
const project = at >= 0 ? rest[at + 1] || "" : (rest.find((a) => a.startsWith("--project=")) || "").slice("--project=".length);
if (!/^demo-[a-z0-9-]+$/.test(project)) {
  console.error(`The emulators run here only on an offline demo-* project (got "${project || "none"}").\n${usage}`);
  process.exit(2);
}

const fb = firebaseCommand();
if (fb.source === "npx") console.log(`No Firebase CLI ${MIN_FIREBASE_MAJOR} or newer on PATH: using firebase-tools ${fb.version} through npx.`);

const child = spawn(fb.cmd, [...fb.prefix, `emulators:${action}`, ...rest], {
  stdio: "inherit",
  env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
});
// Ctrl-C reaches the CLI directly (same process group); a TERM sent to this script is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", (err) => {
  console.error(`Couldn't start ${fb.cmd}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
