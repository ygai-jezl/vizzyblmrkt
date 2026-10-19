// The steps of `npm run selfhost`: the core steps that take an empty Google Cloud project to
// a running copy of YouGrow, and the add-ons. Each step can say what state it is in using
// read-only calls (check), what it would change (changes), and do it (apply). Node built-ins
// only; every cloud call goes through ./cloud.mjs.
//
// A step's check returns { state: "done" | "todo" | "unknown", detail, next?, blocking? }.
// `next` overrides the command printed for it; `blocking` means later checks can't run.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  appHostingBase,
  firebaseApiBase,
  billingState,
  capture,
  createSecret,
  describeProject,
  enabledApis,
  gcloudAccount,
  gcloudJson,
  hasAdc,
  hasFirebase,
  hasGcloud,
  health,
  identityToolkitBase,
  listBackends,
  listWebApps,
  live,
  reason,
  rest,
  secretNames,
  webAppConfig,
} from "./cloud.mjs";
import {
  BUILD_RUNTIME,
  addMissing,
  baseSwitches,
  coreSections,
  entryMap,
  renderEnvFile,
  secretEntry,
  setEntries,
  valueEntry,
} from "./envfile.mjs";
import {
  CORE_SECRETS,
  DEFAULT_BRANCH,
  DEFAULT_ENV,
  DEFAULT_FIRESTORE_LOCATION,
  DEFAULT_REGION,
  REQUIRED_APIS,
  RUNTIME_ROLES,
  SCHEDULER_JOBS,
  SCHEDULER_LOCATION,
  WEB_API_KEY_SECRET,
  WEB_APP_NAME,
  assetBucketName,
  runtimeServiceAccount,
  signingKeyName,
  switchesForAddon,
} from "./spec.mjs";

const done = (detail, extra = {}) => ({ state: "done", detail, ...extra });
const todo = (detail, extra = {}) => ({ state: "todo", detail, ...extra });
const unknown = (detail, extra = {}) => ({ state: "unknown", detail, ...extra });
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (detail, extra = {}) => ({ ok: false, detail: [].concat(detail), ...extra });

const NOT_FOUND = /not.?found|does not exist|NOT_FOUND|404/i;

/** Shell-quote one argument for display. */
export function q(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `npm run selfhost` command for this context, with only the non-default options. */
export function selfhostCommand(ctx, extra = "") {
  const opts = ["--project", ctx.project];
  if (ctx.region !== DEFAULT_REGION) opts.push("--region", ctx.region);
  if (ctx.envName !== DEFAULT_ENV) opts.push("--env", ctx.envName);
  if (ctx.backendId !== ctx.project) opts.push("--backend", ctx.backendId);
  if (ctx.branch !== DEFAULT_BRANCH) opts.push("--branch", ctx.branch);
  return ["npm run selfhost --", ...opts.map(q), extra].filter(Boolean).join(" ");
}

/** Memoised read-only lookups, cleared after every change. */
function memo(ctx, key, fn) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, fn());
  return ctx.memo.get(key);
}

const projectInfo = (ctx) => memo(ctx, "project", () => describeProject(ctx.project));
const backends = (ctx) => memo(ctx, "backends", () => listBackends(ctx.project));
const webApps = (ctx) => memo(ctx, "webapps", () => listWebApps(ctx.project));
const secrets = (ctx) => memo(ctx, "secrets", () => secretNames(ctx.project));

function backend(ctx) {
  const r = backends(ctx);
  return r.ok ? (r.backends.find((b) => b.id === ctx.backendId) ?? null) : undefined;
}

/** The app's https origin: --app-url, else the backend's URL once it exists. */
export function appUrl(ctx) {
  if (ctx.flags.appUrl) return ctx.flags.appUrl;
  const b = backend(ctx);
  return b && b.uri ? b.uri.replace(/\/+$/, "") : "";
}

function webApp(ctx) {
  const r = webApps(ctx);
  if (!r.ok || !r.apps.length) return null;
  return r.apps.find((a) => a.displayName === WEB_APP_NAME) ?? r.apps[0];
}

function envText(ctx) {
  return existsSync(ctx.envFile) ? readFileSync(ctx.envFile, "utf8") : "";
}

function envValue(ctx, name) {
  const e = entryMap(envText(ctx)).get(name);
  return e ? (e.value ?? e.secret ?? "") : "";
}

/** Print a command, then run it with its output shown. */
async function runLive(ctx, cmd, args, opts = {}) {
  const shown = opts.show ?? [cmd, ...args].map(q).join(" ");
  ctx.say(`  $ ${opts.envShown ? `${opts.envShown} ` : ""}${shown}`);
  const code = await live(cmd, args, { cwd: ctx.repoRoot, env: opts.env });
  return code;
}

/** Run a command quietly; print one line about it. */
function runQuiet(ctx, cmd, args, label) {
  const r = capture(cmd, args, { cwd: ctx.repoRoot });
  ctx.say(`  ${r.ok ? "ok  " : "fail"} ${label}${r.ok ? "" : `: ${reason(r)}`}`);
  return r.ok;
}

/** The workspace helper (scripts/selfhost/create-workspace.ts), JSON out. */
function workspaceTool(ctx, args) {
  const override = process.env.SELFHOST_WORKSPACE_TOOL; // tests point this at a stub
  const cmd = override || process.execPath;
  const full = override
    ? args
    : [join(ctx.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(ctx.repoRoot, "scripts", "selfhost", "create-workspace.ts"), ...args];
  // Bill the Firestore calls made with your own credentials (ADC) to the project itself.
  const r = capture(cmd, [...full, "--json"], { cwd: ctx.repoRoot, timeoutMs: 180_000, env: { GOOGLE_CLOUD_QUOTA_PROJECT: ctx.project } });
  const last = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    const data = JSON.parse(last);
    return data.ok ? { ok: true, data } : { ok: false, why: String(data.error ?? "failed") };
  } catch {
    return { ok: false, why: reason(r) || "the workspace helper gave no answer" };
  }
}

const listWorkspaces = (ctx) => memo(ctx, "workspaces", () => workspaceTool(ctx, ["--project", ctx.project, "--list"]));

/** A temporary Firebase config under .selfhost/ (git ignored) that deploys Firestore to the given databases only. */
function firestoreConfig(ctx, databases) {
  const dir = join(ctx.repoRoot, ".selfhost");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "firebase.firestore.json");
  const firestore = databases.map((database) => ({
    database,
    rules: join(ctx.repoRoot, "firestore.rules"),
    indexes: join(ctx.repoRoot, "firestore.indexes.json"),
  }));
  writeFileSync(file, `${JSON.stringify({ firestore }, null, 2)}\n`);
  return file;
}

async function deployFirestore(ctx, databases) {
  const file = firestoreConfig(ctx, databases);
  try {
    return await runLive(ctx, "firebase", ["deploy", "--only", "firestore", "--config", file, "--project", ctx.project, "--non-interactive"], {
      show: `firebase deploy --only firestore --config .selfhost/firebase.firestore.json --project ${ctx.project} --non-interactive`,
    });
  } finally {
    rmSync(file, { force: true });
  }
}

/** Ask for a value unless a flag gave it; with --yes a missing flag is an error. */
async function want(ctx, flag, question, fallback, validate) {
  let value = ctx.flags[flag];
  if (!value) {
    if (ctx.yes) {
      if (fallback) value = fallback;
      else return { ok: false, why: `pass --${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} (with --yes nothing is asked)` };
    } else {
      value = await ctx.prompt.ask(question, fallback);
    }
  }
  const problem = validate ? validate(value) : "";
  return problem ? { ok: false, why: problem } : { ok: true, value };
}

const isEmail = (v) => (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v) ? "" : `"${v}" is not an email address`);
const isHttpsUrl = (v) => {
  try {
    return new URL(v).protocol === "https:" ? "" : "must start with https://";
  } catch {
    return `"${v}" is not a URL (e.g. https://example.com/privacy)`;
  }
};

/** Firestore location to a matching Cloud Storage location. */
function storageLocationFor(firestoreLocation) {
  if (!firestoreLocation || firestoreLocation === "nam5" || firestoreLocation === "nam7" || firestoreLocation.startsWith("us-")) return "US";
  if (firestoreLocation === "eur3" || firestoreLocation.startsWith("europe-")) return "EU";
  return firestoreLocation;
}

function firestoreDb(ctx, database = "(default)") {
  return memo(ctx, `db:${database}`, () => gcloudJson(["firestore", "databases", "describe", `--database=${database}`, `--project=${ctx.project}`]));
}

// ---------------------------------------------------------------------------
// Core steps
// ---------------------------------------------------------------------------

/** @type {any[]} */
export const CORE_STEPS = [
  {
    id: "account",
    title: "Sign in, project and billing",
    manual: true,
    async check(ctx) {
      if (!hasGcloud()) return todo("The Google Cloud CLI (gcloud) is not installed.", { next: "install it: https://cloud.google.com/sdk/docs/install", blocking: true });
      const account = gcloudAccount();
      if (!account) return todo("gcloud is not signed in.", { next: "gcloud auth login", blocking: true });
      const p = projectInfo(ctx);
      if (p.state !== "ok") {
        const why = /permission|not found|may not exist|denied/i.test(p.why) ? "" : ` ${p.why}`;
        return todo(`Project ${ctx.project} wasn't found, or ${account} can't open it.${why}`, {
          next: `check the project id, or create it: gcloud projects create ${ctx.project}`,
          blocking: true,
        });
      }
      const problems = [];
      if (!hasFirebase()) problems.push(["The Firebase CLI is not installed.", "npm install -g firebase-tools && firebase login"]);
      if (!hasAdc()) problems.push(["No Application Default Credentials (the workspace and agent steps use them).", "gcloud auth application-default login"]);
      const billing = billingState(ctx.project);
      if (billing.state === "off") {
        problems.push([
          "Billing is off. App Hosting needs a billing account (the Blaze plan).",
          `link one: https://console.cloud.google.com/billing/linkedaccount?project=${ctx.project}`,
        ]);
      } else if (billing.state === "unknown") {
        problems.push([`Can't read billing: ${billing.why}`, `check it: https://console.cloud.google.com/billing/linkedaccount?project=${ctx.project}`]);
      }
      if (problems.length) return todo(problems.map((x) => x[0]).join(" "), { next: problems[0][1] });
      return done(`signed in as ${account}; billing on`);
    },
    changes: () => [],
    async apply(ctx) {
      const c = await this.check(ctx);
      if (c.state === "done") return ok();
      return fail([`Fix: ${c.next}`, "This step only checks: sign-in and billing are yours to do."]);
    },
  },
  {
    id: "apis",
    title: "Turn on the Google Cloud APIs the app uses",
    async check(ctx) {
      const r = enabledApis(ctx.project);
      if (!r.apis) return unknown(`Can't list the enabled APIs: ${r.why}`);
      const missing = REQUIRED_APIS.filter((a) => !r.apis.has(a.id));
      ctx.state.missingApis = missing;
      if (!missing.length) return done(`all ${REQUIRED_APIS.length} on`);
      return todo(`${missing.length} of ${REQUIRED_APIS.length} to turn on: ${missing.map((a) => a.id.replace(".googleapis.com", "")).join(", ")}`);
    },
    changes: (ctx) => [`Turn on ${(ctx.state.missingApis ?? REQUIRED_APIS).length} APIs: ${(ctx.state.missingApis ?? REQUIRED_APIS).map((a) => a.id).join(", ")}`],
    async apply(ctx) {
      const missing = ctx.state.missingApis ?? REQUIRED_APIS;
      if (!missing.length) return ok();
      const code = await runLive(ctx, "gcloud", ["services", "enable", ...missing.map((a) => a.id), `--project=${ctx.project}`]);
      return code === 0 ? ok() : fail("Turning on the APIs failed (see above).");
    },
  },
  {
    id: "firebase",
    title: "Add Firebase and a web app",
    async check(ctx) {
      const r = webApps(ctx);
      if (!r.ok) {
        // apps:list fails the same way for "no Firebase here" and "not signed in": ask the API.
        const p = await rest(`${firebaseApiBase()}/v1beta1/projects/${ctx.project}`, ctx.project);
        if (p.status === 404 || r.notFirebase) return todo("Firebase isn't added to this project yet.");
        return unknown(`Can't list Firebase apps: ${r.why}`, { next: "firebase login" });
      }
      const app = webApp(ctx);
      if (!app) return todo("Firebase is on; no web app yet.");
      return done(`web app ${app.displayName || app.appId}`);
    },
    changes(ctx) {
      const r = webApps(ctx);
      return [...(r.ok ? [] : [`Add Firebase to ${ctx.project}`]), ...(webApp(ctx) ? [] : [`Create the web app "${WEB_APP_NAME}"`])];
    },
    async apply(ctx) {
      if (!webApps(ctx).ok) {
        const code = await runLive(ctx, "firebase", ["projects:addfirebase", ctx.project]);
        if (code !== 0) return fail("Adding Firebase failed (see above).");
        ctx.memo.clear();
      }
      if (!webApp(ctx)) {
        const code = await runLive(ctx, "firebase", ["apps:create", "WEB", WEB_APP_NAME, "--project", ctx.project]);
        if (code !== 0) return fail("Creating the web app failed (see above).");
      }
      return ok();
    },
  },
  {
    id: "firestore",
    title: "Create the Firestore database, with its rules and indexes",
    async check(ctx) {
      const db = firestoreDb(ctx);
      if (!db.ok) {
        const why = reason(db.result);
        return NOT_FOUND.test(why) ? todo("No Firestore database yet.") : unknown(`Can't read the database: ${why}`);
      }
      if (db.data && db.data.type === "DATASTORE_MODE") return unknown("The default database is in Datastore mode. YouGrow needs Firestore in Native mode: use a new project.");
      const location = db.data?.locationId ?? "";
      const idx = gcloudJson(["firestore", "indexes", "composite", "list", "--database=(default)", `--project=${ctx.project}`]);
      if (idx.ok && Array.isArray(idx.data) && idx.data.length) return done(`(default) in ${location}; rules and indexes deployed`);
      return todo(`(default) in ${location}; rules and indexes not deployed yet`);
    },
    async inputs(ctx) {
      if (firestoreDb(ctx).ok) return ok();
      const r = await want(
        ctx,
        "location",
        `Firestore location (it can't be changed later; ${DEFAULT_FIRESTORE_LOCATION} is the US multi-region, eur3 Europe)`,
        DEFAULT_FIRESTORE_LOCATION,
        (v) => (/^[a-z0-9-]{3,30}$/.test(v) ? "" : `"${v}" is not a Firestore location (see https://firebase.google.com/docs/firestore/locations)`),
      );
      if (!r.ok) return fail(r.why);
      ctx.input.location = r.value;
      return ok();
    },
    changes(ctx) {
      return [
        ...(firestoreDb(ctx).ok ? [] : [`Create the (default) Firestore database in ${ctx.input.location} (permanent)`]),
        "Deploy firestore.rules and firestore.indexes.json to (default) only",
      ];
    },
    async apply(ctx) {
      if (!firestoreDb(ctx).ok) {
        const code = await runLive(ctx, "gcloud", ["firestore", "databases", "create", "--database=(default)", `--location=${ctx.input.location}`, `--project=${ctx.project}`]);
        if (code !== 0) return fail("Creating the database failed (see above).");
      }
      const code = await deployFirestore(ctx, ["(default)"]);
      return code === 0 ? ok() : fail("Deploying the rules and indexes failed (see above).");
    },
  },
  {
    id: "storage",
    title: "Create the private bucket for brand files and images",
    async check(ctx) {
      const r = gcloudJson(["storage", "buckets", "describe", `gs://${assetBucketName(ctx.project)}`, `--project=${ctx.project}`]);
      if (r.ok) return done(`gs://${assetBucketName(ctx.project)}`);
      const why = reason(r.result);
      return NOT_FOUND.test(why) ? todo(`No bucket gs://${assetBucketName(ctx.project)} yet.`) : unknown(`Can't read the bucket: ${why}`);
    },
    changes: (ctx) => [`Create gs://${assetBucketName(ctx.project)} (private: uniform access, public access prevented)`],
    async apply(ctx) {
      const db = firestoreDb(ctx);
      const location = storageLocationFor(db.ok ? db.data?.locationId : "");
      const code = await runLive(ctx, "gcloud", [
        "storage", "buckets", "create", `gs://${assetBucketName(ctx.project)}`, `--project=${ctx.project}`, `--location=${location}`,
        "--uniform-bucket-level-access", "--public-access-prevention",
      ]);
      return code === 0 ? ok() : fail("Creating the bucket failed (see above).");
    },
  },
  {
    id: "secrets",
    title: "Generate the app's secrets in Secret Manager",
    async check(ctx) {
      const r = secrets(ctx);
      if (!r.names) return unknown(`Can't list secrets: ${r.why}`);
      const all = [...CORE_SECRETS.map((s) => s.name), WEB_API_KEY_SECRET.name];
      const missing = all.filter((n) => !r.names.has(n));
      ctx.state.missingSecrets = missing;
      if (!missing.length) return done(`all ${all.length} exist`);
      return todo(`${missing.length} of ${all.length} to create: ${missing.join(", ")}`);
    },
    changes: (ctx) => [`Create ${(ctx.state.missingSecrets ?? []).length} secrets (random values made here and sent on stdin, never shown): ${(ctx.state.missingSecrets ?? []).join(", ")}`],
    async apply(ctx) {
      const missing = new Set(ctx.state.missingSecrets ?? []);
      for (const s of CORE_SECRETS) {
        if (!missing.has(s.name)) continue;
        const value = randomBytes(32).toString(s.encoding === "hex" ? "hex" : "base64");
        const r = createSecret(ctx.project, s.name, value);
        ctx.say(`  ${r.ok ? "ok  " : "fail"} ${s.name}${r.ok ? "" : `: ${r.why}`}`);
        if (!r.ok) return fail(`Creating ${s.name} failed.`);
      }
      if (missing.has(WEB_API_KEY_SECRET.name)) {
        const app = webApp(ctx);
        if (!app) return fail("No web app yet: run the firebase step first.");
        const cfg = webAppConfig(ctx.project, app.appId);
        if (!cfg.ok || !cfg.config?.apiKey) return fail(`Can't read the web app's config: ${cfg.why}`);
        const r = createSecret(ctx.project, WEB_API_KEY_SECRET.name, String(cfg.config.apiKey));
        ctx.say(`  ${r.ok ? "ok  " : "fail"} ${WEB_API_KEY_SECRET.name} (the web app's public API key)${r.ok ? "" : `: ${r.why}`}`);
        if (!r.ok) return fail(`Creating ${WEB_API_KEY_SECRET.name} failed.`);
      }
      return ok();
    },
  },
  {
    id: "workspace",
    title: "Create the first workspace (your brand)",
    async check(ctx) {
      const r = listWorkspaces(ctx);
      if (!r.ok) return unknown(`Can't read workspaces: ${r.why}`);
      const tenants = r.data.tenants ?? [];
      if (!tenants.length) return todo("No workspace yet.");
      return done(tenants.map((t) => `${t.id} (${t.name}, ${t.region})`).join(", "));
    },
    async inputs(ctx) {
      const existing = listWorkspaces(ctx);
      if (existing.ok && (existing.data.tenants ?? []).length && !ctx.flags.anotherWorkspace) {
        return fail(`A workspace already exists: ${existing.data.tenants.map((t) => t.id).join(", ")}. Pass --another-workspace to create one more.`);
      }
      const name = await want(ctx, "workspaceName", "Workspace (brand) name", "", (v) => (/[A-Za-z0-9]/.test(v) && v.length <= 120 ? "" : "the name needs letters or numbers"));
      if (!name.ok) return fail(name.why);
      const domain = await want(ctx, "workspaceDomain", "Its website's domain, e.g. acme.com", "", (v) => (/^(https?:\/\/)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/?$/.test(v) ? "" : `"${v}" is not a domain`));
      if (!domain.ok) return fail(domain.why);
      const region = ctx.flags.workspaceRegion || "us";
      if (!["us", "eu", "asia"].includes(region)) return fail("--workspace-region must be us, eu or asia.");
      if (region !== "us") {
        const database = region === "eu" ? "signups-eu" : "signups-asia";
        if (!firestoreDb(ctx, database).ok) return fail(`The ${region} database (${database}) doesn't exist. Run the regions add-on first: ${selfhostCommand(ctx, "--apply addon:regions")}`);
      }
      Object.assign(ctx.input, { workspaceName: name.value, workspaceDomain: domain.value, workspaceRegion: region });
      return ok();
    },
    changes: (ctx) => [`Create the workspace "${ctx.input.workspaceName}" (${ctx.input.workspaceDomain}, data in ${ctx.input.workspaceRegion}; the region is permanent)`],
    async apply(ctx) {
      const args = ["--project", ctx.project, "--name", ctx.input.workspaceName, "--domain", ctx.input.workspaceDomain, "--region", ctx.input.workspaceRegion];
      if (ctx.flags.anotherWorkspace) args.push("--another");
      const r = workspaceTool(ctx, args);
      if (!r.ok) return fail(`Creating the workspace failed: ${r.why}`);
      ctx.state.tenantId = r.data.id;
      ctx.say(`  ok   workspace ${r.data.id}`);
      return ok();
    },
  },
  {
    id: "backend",
    title: "Create the App Hosting backend and give it access",
    async check(ctx) {
      const r = backends(ctx);
      if (!r.ok) return unknown(`Can't list App Hosting backends: ${r.why}`, { next: "firebase login" });
      const b = backend(ctx);
      if (!b) return todo(`No App Hosting backend "${ctx.backendId}" yet.`);
      if (b.environment !== ctx.envName) return todo(`Backend ${b.id} exists, but its environment name is "${b.environment || "(none)"}", not "${ctx.envName}".`);
      return done(`${b.uri}, environment "${b.environment}", ${b.repository ? "rolls out from GitHub" : "deploys from this folder"}`);
    },
    changes(ctx) {
      const b = backend(ctx);
      const sa = (b && b.serviceAccount) || runtimeServiceAccount(ctx.project);
      return [
        ...(b ? [] : [`Create the App Hosting backend "${ctx.backendId}" in ${ctx.region}, linked to the web app`]),
        ...RUNTIME_ROLES.map((r) => `Grant ${sa} ${r.role} (${r.why})`),
        `Grant ${sa} roles/storage.objectUser on gs://${assetBucketName(ctx.project)}`,
        "Give the backend access to the app's secrets (firebase apphosting:secrets:grantaccess)",
        `Set the backend's environment name to "${ctx.envName}", so it reads apphosting.${ctx.envName}.yaml`,
      ];
    },
    async apply(ctx) {
      let b = backend(ctx);
      if (!b) {
        const app = webApp(ctx);
        if (!app) return fail("No web app yet: run the firebase step first.");
        const code = await runLive(ctx, "firebase", [
          "apphosting:backends:create", "--backend", ctx.backendId, "--primary-region", ctx.region, "--app", app.appId, "--project", ctx.project, "--non-interactive",
        ]);
        if (code !== 0) return fail("Creating the backend failed (see above).");
        ctx.memo.clear();
        b = backend(ctx);
        if (!b) return fail("The backend was created but can't be read back yet. Run this step again in a minute.");
      }
      const sa = b.serviceAccount || runtimeServiceAccount(ctx.project);
      for (const r of RUNTIME_ROLES) {
        runQuiet(ctx, "gcloud", ["projects", "add-iam-policy-binding", ctx.project, `--member=serviceAccount:${sa}`, `--role=${r.role}`, "--condition=None"], `${r.role} for ${sa}`);
      }
      runQuiet(
        ctx,
        "gcloud",
        ["storage", "buckets", "add-iam-policy-binding", `gs://${assetBucketName(ctx.project)}`, `--member=serviceAccount:${sa}`, "--role=roles/storage.objectUser"],
        `roles/storage.objectUser on gs://${assetBucketName(ctx.project)}`,
      );
      const have = secrets(ctx).names ?? new Set();
      const names = [...CORE_SECRETS.map((s) => s.name), WEB_API_KEY_SECRET.name].filter((n) => have.has(n));
      if (names.length) {
        const code = await runLive(ctx, "firebase", ["apphosting:secrets:grantaccess", names.join(","), "--backend", ctx.backendId, "--project", ctx.project, "--non-interactive"]);
        if (code !== 0) return fail("Giving the backend access to the secrets failed (see above).");
      }
      if (b.environment !== ctx.envName) {
        const url = `${appHostingBase()}/v1beta/projects/${ctx.project}/locations/${b.location || ctx.region}/backends/${ctx.backendId}?updateMask=environment`;
        const r = await rest(url, ctx.project, { method: "PATCH", body: { environment: ctx.envName } });
        ctx.say(`  ${r.ok ? "ok  " : "fail"} environment name "${ctx.envName}"${r.ok ? "" : `: ${r.why}`}`);
        if (!r.ok) {
          return fail([
            `Set the environment name by hand: open https://console.firebase.google.com/project/${ctx.project}/apphosting,`,
            `View your backend ${ctx.backendId}, Settings, Environment: enter "${ctx.envName}" and Save.`,
          ]);
        }
      }
      return ok();
    },
  },
  {
    id: "connect",
    title: "Create the key that signs requests to connected products, and data clean-up rules",
    async check(ctx) {
      const r = gcloudJson(["kms", "keys", "describe", "outbound-signing", "--keyring=yougrow-connect", "--location=us-central1", `--project=${ctx.project}`]);
      if (r.ok) return done(signingKeyName(ctx.project));
      const why = reason(r.result);
      return NOT_FOUND.test(why) ? todo("No signing key yet.") : unknown(`Can't read the signing key: ${why}`);
    },
    changes: (ctx) => [
      `Create an HSM signing key ${signingKeyName(ctx.project)} and let the backend sign with it (infra/lifecycle/setup.sh signing-key)`,
      "Turn on Firestore TTL clean-up for old events and drafts on (default) (infra/lifecycle/setup.sh ttl)",
    ],
    async apply(ctx) {
      const script = join(ctx.repoRoot, "infra", "lifecycle", "setup.sh");
      let code = await runLive(ctx, "bash", [script, "signing-key", ctx.project], { env: { BACKEND: ctx.backendId }, show: `bash infra/lifecycle/setup.sh signing-key ${ctx.project}` });
      if (code !== 0) return fail("Creating the signing key failed (see above).");
      code = await runLive(ctx, "bash", [script, "ttl", ctx.project], {
        env: { FIRESTORE_DATABASES: "(default)" },
        envShown: "FIRESTORE_DATABASES='(default)'",
        show: `bash infra/lifecycle/setup.sh ttl ${ctx.project}`,
      });
      return code === 0 ? ok() : fail("Turning on the TTL policies failed (see above).");
    },
  },
  {
    id: "envfile",
    title: "Write your settings file, apphosting.<env>.yaml",
    async check(ctx) {
      const name = `apphosting.${ctx.envName}.yaml`;
      if (!existsSync(ctx.envFile)) return todo(`No ${name} yet.`);
      const lacking = ["ADMIN_ALLOWED_EMAILS", "ADMIN_BOOTSTRAP_TENANT_ID", "EMAIL_DEFAULT_PRIVACY_URL", "CONNECT_ISSUER"].filter((n) => !envValue(ctx, n));
      const missing = addMissing(envText(ctx), wantedEntries(ctx)).added;
      const all = [...new Set([...lacking, ...missing])];
      if (all.length) return todo(`${name} lacks ${all.length}: ${all.slice(0, 6).join(", ")}${all.length > 6 ? ", ..." : ""}`);
      return done(`${name} has everything npm run selfhost writes`);
    },
    async inputs(ctx) {
      if (!appUrl(ctx)) return fail(`No backend yet, so the app's address isn't known. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      let tenantId = envValue(ctx, "ADMIN_BOOTSTRAP_TENANT_ID") || ctx.state.tenantId || "";
      let region = envValue(ctx, "ADMIN_BOOTSTRAP_REGION") || "";
      if (!tenantId) {
        const r = listWorkspaces(ctx);
        const first = r.ok ? (r.data.tenants ?? [])[0] : null;
        if (!first) return fail(`No workspace yet. Run: ${selfhostCommand(ctx, "--apply workspace")}`);
        tenantId = first.id;
        region = first.region;
      }
      const admin = envValue(ctx, "ADMIN_ALLOWED_EMAILS") ? { ok: true, value: envValue(ctx, "ADMIN_ALLOWED_EMAILS") } : await want(ctx, "adminEmail", "Your Google account's email (the first admin)", "", isEmail);
      if (!admin.ok) return fail(admin.why);
      const privacy = envValue(ctx, "EMAIL_DEFAULT_PRIVACY_URL")
        ? { ok: true, value: envValue(ctx, "EMAIL_DEFAULT_PRIVACY_URL") }
        : await want(ctx, "privacyUrl", "Your privacy policy's URL (emails link to it, and journeys don't send without one)", "", isHttpsUrl);
      if (!privacy.ok) return fail(privacy.why);
      Object.assign(ctx.input, { tenantId, region: region || "us", adminEmail: admin.value, privacyUrl: privacy.value });
      return ok();
    },
    changes(ctx) {
      const name = `apphosting.${ctx.envName}.yaml`;
      return [
        existsSync(ctx.envFile) ? `Add the missing entries to ${name} (yours are kept)` : `Write ${name} in this folder`,
        `Admin ${ctx.input.adminEmail}, workspace ${ctx.input.tenantId}, address ${appUrl(ctx)}, secrets by name, switches on (except those needing an add-on)`,
      ];
    },
    async apply(ctx) {
      const entries = wantedEntries(ctx);
      if (!existsSync(ctx.envFile)) {
        writeFileSync(ctx.envFile, renderEnvFile({ project: ctx.project, envName: ctx.envName }, coreSections(sectionValues(ctx))));
        ctx.say(`  ok   wrote apphosting.${ctx.envName}.yaml (${entries.length} entries)`);
      } else {
        const r = addMissing(envText(ctx), entries, `Added by npm run selfhost on ${new Date().toISOString().slice(0, 10)}`);
        writeFileSync(ctx.envFile, r.text);
        ctx.say(`  ok   added ${r.added.length} entr${r.added.length === 1 ? "y" : "ies"} to apphosting.${ctx.envName}.yaml`);
        for (const d of r.differs) ctx.say(`       kept your ${d.name}`);
      }
      const b = backend(ctx);
      if (b && b.repository) ctx.say(`  Next: commit apphosting.${ctx.envName}.yaml and push it to ${ctx.branch} (App Hosting builds from GitHub).`);
      return ok();
    },
  },
  {
    id: "signin",
    title: "Turn on Google sign-in for your app's address",
    async check(ctx) {
      const url = appUrl(ctx);
      if (!url) return todo("Waits for the backend (its address is the domain to authorise).");
      const host = new URL(url).host;
      const base = `${identityToolkitBase()}/admin/v2/projects/${ctx.project}`;
      const idp = await rest(`${base}/defaultSupportedIdpConfigs/google.com`, ctx.project);
      if (idp.status === 404) return todo("Google sign-in is not turned on.");
      if (!idp.ok) return unknown(`Can't read the sign-in settings: ${idp.why}`);
      const cfg = await rest(`${base}/config`, ctx.project);
      if (!cfg.ok) return unknown(`Can't read the authorised domains: ${cfg.why}`);
      const domains = cfg.data?.authorizedDomains ?? [];
      ctx.state.authorizedDomains = domains;
      const missing = [...(idp.data?.enabled ? [] : ["Google sign-in is off"]), ...(domains.includes(host) ? [] : [`${host} is not an authorised domain`])];
      ctx.state.signin = { enabled: Boolean(idp.data?.enabled), host, domainOk: domains.includes(host) };
      if (missing.length) return todo(`${missing.join("; ")}.`);
      return done(`Google sign-in on; ${host} authorised`);
    },
    changes(ctx) {
      const s = ctx.state.signin;
      return s && s.enabled && !s.domainOk ? [`Add ${s.host} to Firebase Authentication's authorised domains`] : [];
    },
    async apply(ctx) {
      const s = ctx.state.signin;
      const url = appUrl(ctx);
      const host = url ? new URL(url).host : "<your app's host>";
      const steps = [
        `1. Open https://console.firebase.google.com/project/${ctx.project}/authentication/providers`,
        "   (click Get started if you see it), choose Google, switch it on, pick a support email, and Save.",
        `2. Open https://console.firebase.google.com/project/${ctx.project}/authentication/settings, Authorized domains,`,
        `   Add domain: ${host}`,
        "Turning on Google sign-in needs the console (it sets up an OAuth client for you).",
      ];
      if (!s || !s.enabled) return fail(steps);
      if (!s.domainOk) {
        const body = { authorizedDomains: [...(ctx.state.authorizedDomains ?? []), s.host] };
        const r = await rest(`${identityToolkitBase()}/admin/v2/projects/${ctx.project}/config?updateMask=authorizedDomains`, ctx.project, { method: "PATCH", body });
        ctx.say(`  ${r.ok ? "ok  " : "fail"} authorised domain ${s.host}${r.ok ? "" : `: ${r.why}`}`);
        if (!r.ok) return fail(steps.slice(2, 4));
      }
      return ok();
    },
  },
  {
    id: "scheduler",
    title: "Create the three scheduled jobs (journeys, emails, posts)",
    async check(ctx) {
      const url = appUrl(ctx);
      if (!url) return todo("Waits for the backend (the jobs call its address).");
      const r = gcloudJson(["scheduler", "jobs", "list", `--location=${SCHEDULER_LOCATION}`, `--project=${ctx.project}`]);
      if (!r.ok) return unknown(`Can't list scheduled jobs: ${reason(r.result)}`);
      const jobs = new Map((r.data ?? []).map((j) => [String(j.name ?? "").split("/").pop(), String(j.httpTarget?.uri ?? "")]));
      const missing = SCHEDULER_JOBS.filter((j) => !(jobs.get(j.job) ?? "").startsWith(`${url}/`));
      ctx.state.missingJobs = missing;
      if (!missing.length) return done(SCHEDULER_JOBS.map((j) => j.job).join(", "));
      return todo(`${missing.length} of 3 to create or point at ${url}: ${missing.map((j) => j.job).join(", ")}`);
    },
    changes: (ctx) => (ctx.state.missingJobs ?? SCHEDULER_JOBS).map((j) => `Create or update ${j.job} (${j.what}) with ${j.script} scheduler, APP_URL=${appUrl(ctx)}`),
    async apply(ctx) {
      const url = appUrl(ctx);
      if (!url) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      for (const j of ctx.state.missingJobs ?? SCHEDULER_JOBS) {
        const code = await runLive(ctx, "bash", [join(ctx.repoRoot, j.script), "scheduler", ctx.project], { env: { APP_URL: url }, envShown: `APP_URL=${url}`, show: `bash ${j.script} scheduler ${ctx.project}` });
        if (code !== 0) return fail(`Creating ${j.job} failed (see above).`);
      }
      return ok();
    },
  },
  {
    id: "rollout",
    title: "Roll out the app and check it answers",
    async check(ctx) {
      const url = appUrl(ctx);
      if (!url) return todo("Waits for the backend.");
      const h = await health(url);
      return h.ok ? done(`${url}/api/health answers`) : todo(`${url} isn't answering yet (${h.why}).`);
    },
    changes(ctx) {
      const b = backend(ctx);
      return [
        b && b.repository
          ? `Start a rollout of backend ${ctx.backendId} from the ${ctx.branch} branch on GitHub`
          : `Upload this folder and roll it out to backend ${ctx.backendId} (local source deploy; .gitignore'd files stay here)`,
        `Then check ${appUrl(ctx) || "the app"}/api/health`,
      ];
    },
    async apply(ctx) {
      const b = backend(ctx);
      if (!b) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      if (!existsSync(ctx.envFile)) return fail(`No apphosting.${ctx.envName}.yaml yet. Run: ${selfhostCommand(ctx, "--apply envfile")}`);
      let code;
      if (b.repository) {
        const status = capture("git", ["status", "--porcelain", "--", `apphosting.${ctx.envName}.yaml`], { cwd: ctx.repoRoot });
        if (status.ok && status.stdout.trim()) return fail(`apphosting.${ctx.envName}.yaml has changes that aren't committed. Commit it, push it to ${ctx.branch}, then run this again.`);
        code = await runLive(ctx, "firebase", ["apphosting:rollouts:create", ctx.backendId, "--git-branch", ctx.branch, "--project", ctx.project, "--force"]);
      } else {
        const file = join(ctx.repoRoot, "firebase.selfhost.json");
        const config = {
          apphosting: [
            {
              backendId: ctx.backendId,
              rootDir: ".",
              ignore: ["node_modules", ".git", ".next", ".local", ".selfhost", "firebase-debug.log", "firebase-debug.*.log", "functions", "agents", "workers"],
            },
          ],
        };
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        try {
          code = await runLive(ctx, "firebase", ["deploy", "--only", `apphosting:${ctx.backendId}`, "--config", "firebase.selfhost.json", "--project", ctx.project, "--non-interactive"]);
        } finally {
          rmSync(file, { force: true });
        }
      }
      if (code !== 0) return fail("The rollout failed (see above). The build log is in the Firebase console, App Hosting, your backend, Rollouts.");
      const url = appUrl(ctx);
      for (let i = 0; i < 6; i++) {
        const h = await health(url);
        if (h.ok) {
          ctx.say(`  ok   ${url}/api/health answers`);
          return ok();
        }
        if (i < 5) await new Promise((r) => setTimeout(r, Number(process.env.SELFHOST_HEALTH_WAIT_MS ?? 10_000)));
      }
      return fail(`The rollout finished but ${url}/api/health doesn't answer yet. Check again in a minute: npm run doctor -- --cloud --project ${ctx.project}`);
    },
  },
];

/** Values for the env file, from what this run knows. */
function sectionValues(ctx) {
  const base = readFileSync(join(ctx.repoRoot, "apphosting.yaml"), "utf8");
  return {
    project: ctx.project,
    appUrl: appUrl(ctx) || undefined,
    adminEmail: ctx.input.adminEmail || envValue(ctx, "ADMIN_ALLOWED_EMAILS") || undefined,
    tenantId: ctx.input.tenantId || envValue(ctx, "ADMIN_BOOTSTRAP_TENANT_ID") || undefined,
    region: ctx.input.region || envValue(ctx, "ADMIN_BOOTSTRAP_REGION") || undefined,
    privacyUrl: ctx.input.privacyUrl || envValue(ctx, "EMAIL_DEFAULT_PRIVACY_URL") || undefined,
    assetBucket: assetBucketName(ctx.project),
    signingKey: signingKeyName(ctx.project),
    switches: baseSwitches(base),
  };
}

/** Every entry the env file should have, flat. */
function wantedEntries(ctx) {
  return coreSections(sectionValues(ctx)).flatMap((s) => s.entries);
}

// ---------------------------------------------------------------------------
// Add-ons
// ---------------------------------------------------------------------------

/** Set entries in the env file for an add-on, and say so. */
function setForAddon(ctx, addon, entries) {
  if (!existsSync(ctx.envFile)) return fail(`No apphosting.${ctx.envName}.yaml yet. Run the core steps first: ${selfhostCommand(ctx, "--apply core")}`);
  const availability = new Map(baseSwitches(readFileSync(join(ctx.repoRoot, "apphosting.yaml"), "utf8")).map((s) => [s.name, s.availability]));
  const switches = switchesForAddon(addon).map((name) => valueEntry(name, "true", availability.get(name) ?? BUILD_RUNTIME));
  const r = setEntries(envText(ctx), [...entries, ...switches], `addon:${addon}, set by npm run selfhost on ${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(ctx.envFile, r.text);
  ctx.say(`  ok   apphosting.${ctx.envName}.yaml: ${r.changed.length ? r.changed.join(", ") : "already up to date"}`);
  ctx.say(`  Next: roll out the app so it reads them: ${selfhostCommand(ctx, "--apply rollout")}`);
  return ok();
}

/** Ask for a key without echoing it, then store it in Secret Manager (new secret or new version). */
async function storeTypedSecret(ctx, name, label) {
  const value = await ctx.prompt.askHidden(`${label} (typed input is hidden)`);
  if (!value) return { ok: false, why: `nothing entered for ${label}` };
  const exists = (secrets(ctx).names ?? new Set()).has(name);
  const r = exists
    ? capture("gcloud", ["secrets", "versions", "add", name, `--project=${ctx.project}`, "--data-file=-"], { input: value })
    : capture("gcloud", ["secrets", "create", name, `--project=${ctx.project}`, "--replication-policy=automatic", "--data-file=-"], { input: value });
  ctx.say(`  ${r.ok ? "ok  " : "fail"} ${name}${exists ? " (new version)" : ""}${r.ok ? "" : `: ${reason(r)}`}`);
  return r.ok ? { ok: true } : { ok: false, why: `storing ${name} failed` };
}

async function grantAccess(ctx, names) {
  const code = await runLive(ctx, "firebase", ["apphosting:secrets:grantaccess", names.join(","), "--backend", ctx.backendId, "--project", ctx.project, "--non-interactive"]);
  return code === 0;
}

const needsTerminal = (ctx, addon) =>
  fail([`This add-on asks for keys, so it needs your own terminal (keys are never passed on the command line or through a coding agent).`, `Run it yourself: ${selfhostCommand(ctx, `--apply addon:${addon}`)}`]);

/** Run a command, show its output live, and also keep it (for ids it prints). */
function runTee(ctx, cmd, args, opts = {}) {
  ctx.say(`  $ ${opts.envShown ? `${opts.envShown} ` : ""}${opts.show ?? [cmd, ...args].map(q).join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ctx.repoRoot, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("error", () => resolve({ code: 127, out }));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** @type {any[]} */
export const ADDONS = [
  {
    id: "addon:email",
    title: "Send real email (Mandrill or Resend)",
    how: "automated; asks for your API key in your own terminal",
    check(ctx) {
      const e = entryMap(envText(ctx));
      return e.has("MANDRILL_API_KEY") || e.has("RESEND_API_KEY") ? done(`provider set; EMAIL_FROM ${envValue(ctx, "EMAIL_FROM") || "(default)"}`) : todo("not set up: emails are written to the log");
    },
    async inputs(ctx) {
      if (!ctx.prompt.canHide()) return needsTerminal(ctx, "email");
      const provider = await want(ctx, "provider", "Email provider: mandrill or resend", "mandrill", (v) => (["mandrill", "resend"].includes(v) ? "" : "pick mandrill or resend"));
      if (!provider.ok) return fail(provider.why);
      const from = await want(ctx, "emailFrom", 'Sender, e.g. "Acme <hello@example.com>" (a domain your provider has verified)', "", (v) => (/@/.test(v) ? "" : "needs an email address"));
      if (!from.ok) return fail(from.why);
      Object.assign(ctx.input, { provider: provider.value, emailFrom: from.value });
      return ok();
    },
    changes: (ctx) => [`Store your ${ctx.input.provider} API key as ${ctx.input.provider}-api-key and give the backend access`, `Set EMAIL_FROM and the key's reference in apphosting.${ctx.envName}.yaml`],
    async apply(ctx) {
      const name = `${ctx.input.provider}-api-key`;
      const env = ctx.input.provider === "mandrill" ? "MANDRILL_API_KEY" : "RESEND_API_KEY";
      const s = await storeTypedSecret(ctx, name, `${ctx.input.provider === "mandrill" ? "Mandrill" : "Resend"} API key`);
      if (!s.ok) return fail(s.why);
      if (!(await grantAccess(ctx, [name]))) return fail("Giving the backend access failed (see above).");
      const r = setForAddon(ctx, "email", [secretEntry(env, name), valueEntry("EMAIL_FROM", ctx.input.emailFrom)]);
      ctx.say("  Product journeys still run in test mode (nothing real is sent) until you add");
      ctx.say(`  LIFECYCLE_MODE_CEILING with the value "live" to apphosting.${ctx.envName}.yaml. Waitlist emails send now.`);
      if (ctx.input.provider === "mandrill") ctx.say("  For opens and clicks, add Mandrill's webhook: MANDRILL_WEBHOOK_KEY (secret) and MANDRILL_WEBHOOK_URL (see .env.example).");
      return r;
    },
  },
  {
    id: "addon:vizzy",
    title: "Vizzy, the chat agent (Agent Runtime)",
    how: "automated; needs Python 3.10+ for the deploy tools",
    check(ctx) {
      return envValue(ctx, "ROOT_AGENT_RESOURCE_ID") ? done(`engine ${envValue(ctx, "ROOT_AGENT_RESOURCE_ID")}`) : todo("not set up");
    },
    async inputs(ctx) {
      if (!appUrl(ctx)) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      if (!existsSync(join(ctx.repoRoot, "agents", ".venv", "bin", "python"))) {
        return fail([
          "The agent's deploy tools aren't installed. Run these once, then this add-on again:",
          "  python3.12 -m venv agents/.venv",
          "  agents/.venv/bin/pip install -r agents/requirements-deploy.txt",
        ]);
      }
      return ok();
    },
    changes: (ctx) => [
      `Create the agent's service account and roles (infra/agent/setup.sh all ${ctx.project})`,
      `${envValue(ctx, "ROOT_AGENT_RESOURCE_ID") ? `Update engine ${envValue(ctx, "ROOT_AGENT_RESOURCE_ID")}` : "Create a new agent engine"} with agents/root_agent/deploy.sh (CANVAS_CALLBACK_URL=${appUrl(ctx)})`,
      `Set ROOT_AGENT_RESOURCE_ID and turn on ${switchesForAddon("vizzy").length} Vizzy switches in apphosting.${ctx.envName}.yaml`,
    ],
    async apply(ctx) {
      const code = await runLive(ctx, "bash", [join(ctx.repoRoot, "infra", "agent", "setup.sh"), "all", ctx.project], { show: `bash infra/agent/setup.sh all ${ctx.project}` });
      if (code !== 0) return fail("Setting up the agent's identity failed (see above).");
      const engine = envValue(ctx, "ROOT_AGENT_RESOURCE_ID");
      const env = { PROJECT: ctx.project, CANVAS_CALLBACK_URL: appUrl(ctx), REGION: ctx.region, ...(engine ? { AGENT_ENGINE_ID: engine } : {}) };
      const r = await runTee(ctx, "bash", [join(ctx.repoRoot, "agents", "root_agent", "deploy.sh")], {
        env,
        envShown: Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" "),
        show: "bash agents/root_agent/deploy.sh",
      });
      if (r.code !== 0) return fail("The agent deploy failed (see above).");
      const id = engine || (r.out.match(/AGENT_ENGINE_ID=(\d+)/) ?? r.out.match(/reasoningEngines\/(\d+)/) ?? [])[1];
      if (!id) return fail("The deploy finished but its engine id wasn't found in the output. Put it in ROOT_AGENT_RESOURCE_ID by hand.");
      return setForAddon(ctx, "vizzy", [valueEntry("ROOT_AGENT_RESOURCE_ID", id), valueEntry("ROOT_AGENT_LOCATION", ctx.region)]);
    },
  },
  {
    id: "addon:knowledge",
    title: "Knowledge search: read websites and repos (a Cloud Run job)",
    how: "automated",
    check(ctx) {
      return envValue(ctx, "KNOWLEDGE_JOB_NAME") ? done(`job ${envValue(ctx, "KNOWLEDGE_JOB_NAME")}`) : todo("not set up");
    },
    changes: (ctx) => [`Create the job's service account, roles and the knowledge-scraper Cloud Run job (infra/knowledge/setup.sh sa, roles, iam, job, secrets)`, `Set KNOWLEDGE_JOB_NAME and turn on KNOWLEDGE_RAG_ENABLED in apphosting.${ctx.envName}.yaml`],
    async apply(ctx) {
      const script = join(ctx.repoRoot, "infra", "knowledge", "setup.sh");
      // The repo-wide index deploy (setup.sh index) covers every database in firebase.json;
      // the core firestore step already deployed the indexes to (default).
      for (const cmd of ["sa", "roles", "iam", "job", "secrets"]) {
        const code = await runLive(ctx, "bash", [script, cmd, ctx.project], { show: `bash infra/knowledge/setup.sh ${cmd} ${ctx.project}` });
        if (code !== 0) return fail(`infra/knowledge/setup.sh ${cmd} failed (see above).`);
      }
      return setForAddon(ctx, "knowledge", [valueEntry("KNOWLEDGE_JOB_NAME", "knowledge-scraper"), valueEntry("KNOWLEDGE_JOB_LOCATION", "us-central1")]);
    },
  },
  {
    id: "addon:github-app",
    title: "Read-only GitHub App (learn a product from its repo)",
    how: "opens GitHub in your browser, where you click Create",
    check(ctx) {
      return envValue(ctx, "GITHUB_APP_ID") ? done(`app ${envValue(ctx, "GITHUB_APP_SLUG") || envValue(ctx, "GITHUB_APP_ID")}`) : todo("not set up");
    },
    async inputs(ctx) {
      if (!appUrl(ctx)) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      if (ctx.yes && !process.stdout.isTTY) return fail(["This add-on opens GitHub in a browser, where you click Create.", `Run it yourself: ${selfhostCommand(ctx, "--apply addon:github-app")}`]);
      return ok();
    },
    changes: (ctx) => [
      `Open GitHub to create a read-only app "${ctx.flags.githubAppName || "YouGrow"}" with callback ${appUrl(ctx)}/api/admin/integrations/github/callback`,
      "Store its private key and client secret in Secret Manager (never shown) and give the backend access",
      `Set the app's public ids in apphosting.${ctx.envName}.yaml and turn on GIT_REPO_SELECTION_ENABLED`,
    ],
    async apply(ctx) {
      const args = [join(ctx.repoRoot, "infra", "github-app", "create-app.mjs"), "--project", ctx.project, "--backend", ctx.backendId, "--origin", appUrl(ctx), "--name", ctx.flags.githubAppName || "YouGrow"];
      const r = await runTee(ctx, process.execPath, args, { show: `node infra/github-app/create-app.mjs ${args.slice(1).map(q).join(" ")}` });
      if (r.code !== 0) return fail("Creating the GitHub App failed (see above).");
      const pick = (k) => (r.out.match(new RegExp(`${k}=(\\S+)`)) ?? [])[1] ?? "";
      const id = pick("GITHUB_APP_ID");
      if (!id) return fail("The app was created but its ids weren't found in the output. Copy them into apphosting.<env>.yaml by hand.");
      return setForAddon(ctx, "github-app", [
        valueEntry("GITHUB_APP_ID", id),
        valueEntry("GITHUB_APP_SLUG", pick("GITHUB_APP_SLUG")),
        valueEntry("GITHUB_APP_CLIENT_ID", pick("GITHUB_APP_CLIENT_ID")),
        secretEntry("GITHUB_APP_CLIENT_SECRET", "github-app-client-secret"),
        secretEntry("GITHUB_APP_PRIVATE_KEY", "github-app-private-key"),
        valueEntry("GIT_OAUTH_ORIGIN", appUrl(ctx)),
      ]);
    },
  },
  ...["linkedin", "x"].map((network) => {
    const isX = network === "x";
    const label = isX ? "X" : "LinkedIn";
    const prefix = isX ? "x-oauth" : "linkedin-oauth";
    const env = isX ? "X_OAUTH" : "LINKEDIN_OAUTH";
    const callback = isX ? "/api/admin/integrations/x/callback" : "/api/admin/integrations/linkedin/callback";
    return {
      id: `addon:${network}`,
      title: `Post to ${label}`,
      how: `you create the ${label} app on its developer site; then automated, asking for its keys in your own terminal`,
      check(ctx) {
        return envValue(ctx, `${env}_CLIENT_ID`) ? done(`${label} app set`) : todo("not set up");
      },
      async inputs(ctx) {
        if (!appUrl(ctx)) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
        if (!ctx.prompt.canHide()) return needsTerminal(ctx, network);
        ctx.say(`  First create the app at ${isX ? "https://developer.x.com" : "https://developer.linkedin.com/apps"} with this callback URL:`);
        ctx.say(`    ${appUrl(ctx)}${callback}`);
        ctx.say(`  The header of infra/${prefix}/setup.sh lists the products and scopes to ask for.`);
        return ok();
      },
      changes: (ctx) => [`Store the ${label} app's client id and secret as ${prefix}-client-id and ${prefix}-client-secret, and give the backend access`, `Set them by name in apphosting.${ctx.envName}.yaml and turn on posting`],
      async apply(ctx) {
        // Not infra/x-oauth/setup.sh: that script also adds a new version of social-token-enc-key,
        // which would make tokens already stored with the old one unreadable.
        for (const [suffix, what] of [["client-id", "Client ID"], ["client-secret", "Client Secret"]]) {
          const s = await storeTypedSecret(ctx, `${prefix}-${suffix}`, `${label} OAuth 2.0 ${what}`);
          if (!s.ok) return fail(s.why);
        }
        if (!(await grantAccess(ctx, [`${prefix}-client-id`, `${prefix}-client-secret`]))) return fail("Giving the backend access failed (see above).");
        return setForAddon(ctx, network, [secretEntry(`${env}_CLIENT_ID`, `${prefix}-client-id`), secretEntry(`${env}_CLIENT_SECRET`, `${prefix}-client-secret`), secretEntry("SOCIAL_TOKEN_ENC_KEY", "social-token-enc-key")]);
      },
    };
  }),
  {
    id: "addon:regions",
    title: "EU and Asia databases (data residency)",
    how: "automated",
    check(ctx) {
      const eu = firestoreDb(ctx, "signups-eu").ok;
      const asia = firestoreDb(ctx, "signups-asia").ok;
      return eu && asia ? done("signups-eu, signups-asia") : todo(`missing: ${[eu ? "" : "signups-eu", asia ? "" : "signups-asia"].filter(Boolean).join(", ")}`);
    },
    changes: () => [
      "Create Firestore databases signups-eu (eur3) and signups-asia (asia-southeast1): each bills on its own and its location is permanent",
      "Deploy the rules and indexes to them, and turn on their TTL clean-up",
    ],
    async apply(ctx) {
      for (const [database, location] of [["signups-eu", "eur3"], ["signups-asia", "asia-southeast1"]]) {
        if (firestoreDb(ctx, database).ok) continue;
        const code = await runLive(ctx, "gcloud", ["firestore", "databases", "create", `--database=${database}`, `--location=${location}`, `--project=${ctx.project}`]);
        if (code !== 0) return fail(`Creating ${database} failed (see above).`);
      }
      let code = await deployFirestore(ctx, ["signups-eu", "signups-asia"]);
      if (code !== 0) return fail("Deploying the rules and indexes failed (see above).");
      code = await runLive(ctx, "bash", [join(ctx.repoRoot, "infra", "lifecycle", "setup.sh"), "ttl", ctx.project], {
        env: { FIRESTORE_DATABASES: "signups-eu signups-asia" },
        envShown: "FIRESTORE_DATABASES='signups-eu signups-asia'",
        show: `bash infra/lifecycle/setup.sh ttl ${ctx.project}`,
      });
      return code === 0 ? ok() : fail("Turning on the TTL policies failed (see above).");
    },
  },
  {
    id: "addon:bigquery",
    title: "Analytics from BigQuery (datasets and export extensions)",
    how: "automated; the extensions deploy may ask you to accept their permissions",
    check(ctx) {
      return envValue(ctx, "ANALYTICS_BQ_ENABLED") === "true" ? done("on") : todo("not set up");
    },
    changes: () => [
      "Grant Cloud Functions build roles, create the waitlist_us/eu/asia datasets (infra/bigquery-analytics/setup.sh)",
      "Deploy the Firestore to BigQuery export extensions (US only, unless the EU and Asia databases exist)",
      "Create the typed views and the widget_views table, wire each export's invoker, grant the backend BigQuery read access",
    ],
    async apply(ctx) {
      const script = join(ctx.repoRoot, "infra", "bigquery-analytics", "setup.sh");
      const step = async (cmd) => (await runLive(ctx, "bash", [script, cmd, ctx.project], { show: `bash infra/bigquery-analytics/setup.sh ${cmd} ${ctx.project}` })) === 0;
      for (const cmd of ["buildperms", "datasets"]) if (!(await step(cmd))) return fail(`infra/bigquery-analytics/setup.sh ${cmd} failed (see above).`);
      const regions = firestoreDb(ctx, "signups-eu").ok && firestoreDb(ctx, "signups-asia").ok;
      const only = regions ? "extensions" : "extensions:fsbq-signups-us,extensions:fsbq-email-events-us";
      const code = await runLive(ctx, "firebase", ["deploy", "--only", only, "--project", ctx.project]);
      if (code !== 0) return fail("Deploying the extensions failed (see above).");
      for (const cmd of ["schema", "serviceaccounts", "iam"]) if (!(await step(cmd))) return fail(`infra/bigquery-analytics/setup.sh ${cmd} failed (see above).`);
      ctx.say(`  To copy existing sign-ups into BigQuery: bash infra/bigquery-analytics/setup.sh backfill ${ctx.project}`);
      return setForAddon(ctx, "bigquery", []);
    },
  },
  {
    id: "addon:recaptcha",
    title: "reCAPTCHA on waitlist sign-ups",
    how: "automated",
    check(ctx) {
      return envValue(ctx, "NEXT_PUBLIC_RECAPTCHA_SITE_KEY") ? done("site key set") : todo("not set up");
    },
    async inputs(ctx) {
      if (!appUrl(ctx)) return fail(`No backend yet. Run: ${selfhostCommand(ctx, "--apply backend")}`);
      return ok();
    },
    changes: (ctx) => [
      `Turn on the reCAPTCHA Enterprise API and create a score key for ${new URL(appUrl(ctx)).host}`,
      `Grant the backend roles/recaptchaenterprise.agent; set the site key and turn on RECAPTCHA_ENABLED in apphosting.${ctx.envName}.yaml`,
    ],
    async apply(ctx) {
      const code = await runLive(ctx, "gcloud", ["services", "enable", "recaptchaenterprise.googleapis.com", `--project=${ctx.project}`]);
      if (code !== 0) return fail("Turning on the reCAPTCHA API failed (see above).");
      const host = new URL(appUrl(ctx)).host;
      const r = gcloudJson(["recaptcha", "keys", "create", "--display-name=yougrow-waitlist", "--web", "--integration-type=score", `--domains=${host}`, `--project=${ctx.project}`]);
      if (!r.ok) return fail(`Creating the key failed: ${reason(r.result)}`);
      const key = String(r.data?.name ?? "").split("/").pop();
      if (!key) return fail("The key was created but its id wasn't returned.");
      const b = backend(ctx);
      const sa = (b && b.serviceAccount) || runtimeServiceAccount(ctx.project);
      runQuiet(ctx, "gcloud", ["projects", "add-iam-policy-binding", ctx.project, `--member=serviceAccount:${sa}`, "--role=roles/recaptchaenterprise.agent", "--condition=None"], `roles/recaptchaenterprise.agent for ${sa}`);
      return setForAddon(ctx, "recaptcha", [valueEntry("RECAPTCHA_PROJECT_ID", ctx.project), valueEntry("NEXT_PUBLIC_RECAPTCHA_SITE_KEY", key, BUILD_RUNTIME)]);
    },
  },
];

export const ALL_STEPS = [...CORE_STEPS, ...ADDONS];
