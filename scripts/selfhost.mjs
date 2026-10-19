#!/usr/bin/env node
// npm run selfhost: host YouGrow on your own Google Cloud project, step by step.
//
//   npm run selfhost -- --project <id>                    the plan: every step, its state, the next command
//   npm run selfhost -- --project <id> --apply core       run the core steps in order (asks before each)
//   npm run selfhost -- --project <id> --apply <step>     run one step, e.g. --apply firestore
//   npm run selfhost -- --project <id> --apply addon:<n>  run an add-on, e.g. --apply addon:email
//
// Options: --region (us-central1), --env (live: your settings file is apphosting.<env>.yaml),
// --backend (the project id), --branch (main), --yes (don't ask; for coding agents, after the
// user agreed), --json (the plan as JSON), and answers: --location, --admin-email,
// --privacy-url, --workspace-name, --workspace-domain, --workspace-region,
// --another-workspace, --provider, --email-from, --github-app-name, --app-url.
//
// The plan only reads. Nothing changes without --apply. docs/self-host.md explains each step.
// Node built-ins only; it shells out to gcloud and firebase.

import { join } from "node:path";
import { REPO_ROOT } from "./lib/local-env.mjs";
import { createPrompter } from "./selfhost/prompt.mjs";
import { BACKEND_ID_RE, DEFAULT_BRANCH, DEFAULT_ENV, DEFAULT_REGION, ENV_NAME_RE, PROJECT_ID_RE, REGION_RE } from "./selfhost/spec.mjs";
import { ADDONS, ALL_STEPS, CORE_STEPS, selfhostCommand } from "./selfhost/steps.mjs";

const BOOLEAN_FLAGS = new Set(["yes", "help", "json", "another-workspace"]);
const VALUE_FLAGS = new Set([
  "project", "region", "env", "backend", "branch", "apply", "location", "admin-email", "privacy-url",
  "workspace-name", "workspace-domain", "workspace-region", "provider", "email-from", "github-app-name", "app-url",
]);

function usage() {
  return [
    "npm run selfhost -- --project <id> [--region us-central1] [--env live] [--apply <step|core|addon:name>] [--yes]",
    "",
    "With only --project it prints the plan: each step, whether it is done, and the next command.",
    "Nothing changes without --apply. Steps: " + CORE_STEPS.map((s) => s.id).join(", ") + ".",
    "Add-ons: " + ADDONS.map((s) => s.id).join(", ") + ".",
    "Guide: docs/self-host.md",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { _errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._errors.push(`unexpected "${a}"`);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(key)) out[key] = true;
    else if (VALUE_FLAGS.has(key)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) out._errors.push(`--${key} needs a value`);
      else out[key] = value;
    } else out._errors.push(`unknown option --${key}`);
  }
  return out;
}

function httpsOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return "";
    return u.origin;
  } catch {
    return "";
  }
}

const stateLabel = { done: "done", todo: "to do", unknown: "can't tell" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const project = args.project ?? "";
  const errors = [...args._errors];
  if (!project) errors.push("--project <your Google Cloud project id> is required");
  else if (!PROJECT_ID_RE.test(project)) errors.push(`"${project}" is not a Google Cloud project id (6 to 30 lowercase letters, digits and hyphens, starting with a letter)`);
  else if (project.startsWith("demo-")) errors.push(`${project} is an emulator-only project id. For a laptop run use: npm run local`);
  const region = args.region ?? DEFAULT_REGION;
  if (!REGION_RE.test(region)) errors.push(`--region "${region}" is not a region, e.g. us-central1`);
  const envName = args.env ?? DEFAULT_ENV;
  if (!ENV_NAME_RE.test(envName)) errors.push(`--env "${envName}" must be lowercase letters, digits and hyphens`);
  const backendId = args.backend ?? project;
  if (project && !BACKEND_ID_RE.test(backendId)) errors.push(`--backend "${backendId}" is not a backend id`);
  const appUrlFlag = args["app-url"] ? httpsOrigin(args["app-url"]) : "";
  if (args["app-url"] && !appUrlFlag) errors.push("--app-url must be an https origin with no path, e.g. https://app.example.com");
  const apply = args.apply;
  const target = apply === undefined || apply === "core" ? null : ALL_STEPS.find((s) => s.id === apply);
  if (apply !== undefined && apply !== "core" && !target) errors.push(`--apply "${apply}" is not a step. Steps: core, ${ALL_STEPS.map((s) => s.id).join(", ")}`);
  if (errors.length) {
    for (const e of errors) console.error(`Error: ${e}`);
    console.error(`\n${usage()}`);
    return 2;
  }

  const prompt = createPrompter();
  const ctx = {
    project,
    region,
    envName,
    backendId,
    branch: args.branch ?? DEFAULT_BRANCH,
    repoRoot: REPO_ROOT,
    envFile: join(REPO_ROOT, `apphosting.${envName}.yaml`),
    yes: Boolean(args.yes),
    flags: {
      location: args.location,
      adminEmail: args["admin-email"],
      privacyUrl: args["privacy-url"],
      workspaceName: args["workspace-name"],
      workspaceDomain: args["workspace-domain"],
      workspaceRegion: args["workspace-region"],
      anotherWorkspace: Boolean(args["another-workspace"]),
      provider: args.provider,
      emailFrom: args["email-from"],
      githubAppName: args["github-app-name"],
      appUrl: appUrlFlag,
    },
    memo: new Map(),
    state: {},
    input: {},
    prompt,
    say: (line) => console.log(line),
  };

  try {
    if (apply === undefined) return await plan(ctx, Boolean(args.json));
    return await run(ctx, apply === "core" ? CORE_STEPS : [target], apply === "core");
  } finally {
    prompt.close();
  }
}

/** Check every core step (read-only) and print the plan. */
async function plan(ctx, asJson) {
  const rows = [];
  let blocked = null;
  for (const step of CORE_STEPS) {
    if (blocked) {
      rows.push({ step, c: { state: "unknown", detail: `after the ${blocked} step` } });
      continue;
    }
    const c = await step.check(ctx);
    rows.push({ step, c });
    if (c.blocking) blocked = step.id;
  }
  const addonRows = [];
  for (const step of ADDONS) {
    const c = blocked ? { state: "unknown", detail: "after the core steps" } : await step.check(ctx);
    addonRows.push({ step, c });
  }
  const first = rows.find((r) => r.c.state !== "done");
  const nextCommand = first ? first.c.next || selfhostCommand(ctx, `--apply ${first.step.id}`) : "";

  if (asJson) {
    const out = (r) => ({ id: r.step.id, title: r.step.title, state: r.c.state, detail: r.c.detail, next: r.c.state === "done" ? "" : r.c.next || selfhostCommand(ctx, `--apply ${r.step.id}`) });
    console.log(JSON.stringify({ project: ctx.project, region: ctx.region, env: ctx.envName, backend: ctx.backendId, steps: rows.map(out), addons: addonRows.map(out), next: nextCommand }, null, 2));
    return 0;
  }

  const say = ctx.say;
  say(`YouGrow self-host plan for ${ctx.project}`);
  say(`Region ${ctx.region}, environment "${ctx.envName}" (apphosting.${ctx.envName}.yaml), backend ${ctx.backendId}`);
  say("Read-only checks: nothing was changed.");
  say("");
  say("Core steps");
  rows.forEach(({ step, c }, i) => {
    say(`  ${String(i + 1).padStart(2)}  ${step.id.padEnd(10)} ${stateLabel[c.state].padEnd(10)} ${step.title}`);
    if (c.detail) say(`${" ".repeat(27)}${c.detail}`);
    if (c.state !== "done" && !c.detail.startsWith("after the")) say(`${" ".repeat(27)}run: ${c.next || selfhostCommand(ctx, `--apply ${step.id}`)}`);
  });
  say("");
  say("Add-ons (optional, once the core steps are done)");
  for (const { step, c } of addonRows) {
    say(`      ${step.id.padEnd(17)} ${(c.state === "done" ? "set up" : c.state === "todo" ? "not set up" : "can't tell").padEnd(11)} ${step.title}`);
    say(`${" ".repeat(35)}${step.how}`);
  }
  say("");
  if (first) {
    say(`Next: ${nextCommand}`);
    say(`Or run every core step in order: ${selfhostCommand(ctx, "--apply core")}`);
    say("--apply shows what each step changes and asks first. Coding agents: get the user's go-ahead, then add --yes.");
  } else {
    say(`Every core step is done. Check it any time: npm run doctor -- --cloud --project ${ctx.project}`);
    say(`Add an add-on: ${selfhostCommand(ctx, "--apply addon:<name>")}`);
  }
  return 0;
}

/** Run steps in order, asking before each one that changes something. */
async function run(ctx, steps, isCore) {
  const say = ctx.say;
  if (ctx.yes) say("--yes: going ahead without asking. Coding agents: only with the user's go-ahead.");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = isCore ? `Step ${i + 1} of ${steps.length} (${step.id})` : step.id;
    const c = await step.check(ctx);
    const isAddon = step.id.startsWith("addon:");
    if (c.state === "done" && !isAddon && step.id !== "rollout") {
      say(`${label}: done already. ${c.detail}`);
      continue;
    }
    say("");
    say(`${label}: ${step.title}`);
    say(`  Project: ${ctx.project}`);
    if (c.detail) say(`  Now: ${c.state === "done" && isAddon ? `set up already (${c.detail}); running it again updates it` : c.detail}`);
    if (c.blocking || (step.manual && c.state !== "done")) {
      const r = await step.apply(ctx);
      return stop(ctx, r.detail ?? [c.detail], step);
    }
    if (step.inputs) {
      const r = await step.inputs(ctx);
      if (!r.ok) return stop(ctx, r.detail, step);
    }
    const changes = step.changes(ctx);
    if (changes.length) {
      say("  It will:");
      for (const line of changes) say(`    - ${line}`);
      if (!ctx.yes) {
        const yes = await ctx.prompt.confirm("  Go ahead?");
        if (!yes) {
          say("Stopped. Nothing else was changed.");
          return 1;
        }
      }
    }
    const r = await step.apply(ctx);
    ctx.memo.clear();
    if (!r.ok) return stop(ctx, r.detail, step);
    const after = await step.check(ctx);
    if (after.state === "done") say(`  Done: ${after.detail}`);
    else say(`  Not confirmed yet: ${after.detail}`);
  }
  say("");
  say(isCore ? `Core steps finished. Check them any time: npm run doctor -- --cloud --project ${ctx.project}` : "Finished.");
  say(`See where things stand: ${selfhostCommand(ctx)}`);
  return 0;
}

function stop(ctx, lines, step) {
  for (const line of [].concat(lines ?? [])) ctx.say(`  ${line}`);
  ctx.say(`When that's done, run: ${selfhostCommand(ctx, `--apply ${step.id}`)}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  },
);
