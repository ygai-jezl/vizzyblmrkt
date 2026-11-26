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
  isFirebaseSignInFailure,
  FIREBASE_REAUTH,
  listBackends,
  listWebApps,
  live,
  reason,
  rest,
  secretNames,
  secretsReadableBy,
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
  PASSWORD_APIS,
  PASSWORD_MIN_LENGTH,
  REQUIRED_APIS,
  RUNTIME_ROLES,
  SCHEDULER_JOBS,
  SCHEDULER_LOCATION,
  SEARCH_COLLECTION_GROUP,
  SEARCH_DATABASES,
  SEARCH_VECTOR_DIM,
  WEB_API_KEY_SECRET,
  WEB_APP_NAME,
  assetBucketName,
  IDENTITY_PLATFORM_UPGRADE,
  NEEDS_UPGRADE_NOTE,
  authAlertPoliciesFor,
  authLogMetricsFor,
  isPlainFirebaseAuth,
  logMetricBody,
  passwordConfigDiff,
  passwordPatchPlan,
  runtimeServiceAccount,
  searchDatabaseArgs,
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
  return ["npm run selfhost --", ...opts.map(q), extra, ...carriedOptions(ctx, extra)].filter(Boolean).join(" ");
}

/**
 * The run's own options a printed command must keep, so following it does what this run was asked
 * to: --app-url for every command (the backend list may still be unreadable), and addon:password's
 * --upgrade-identity-platform and --alert-email for a command that runs that add-on. Left out when
 * `extra` names them already.
 * @param {any} ctx
 * @param {string} extra
 */
function carriedOptions(ctx, extra) {
  const flags = ctx.flags ?? {};
  const has = (name) => new RegExp(`(^|\\s)${name}(\\s|=|$)`).test(extra);
  const out = [];
  if (flags.appUrl && !has("--app-url")) out.push("--app-url", q(flags.appUrl));
  if (/(^|\s)--apply addon:password(\s|$)/.test(extra)) {
    if (flags.upgradeIdentityPlatform && !has("--upgrade-identity-platform")) out.push("--upgrade-identity-platform");
    if (flags.alertEmail && !has("--alert-email")) out.push("--alert-email", q(String(flags.alertEmail).trim()));
  }
  return out;
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

/**
 * The app's secrets that exist but the backend's service account can't read: a core secret added
 * since the backend step last ran (connectors-vault-key, say). A rollout that names one fails with
 * "Error resolving secret version". { ok, missing, why }.
 */
function secretsWithoutAccess(ctx, serviceAccount) {
  return memo(ctx, `secretAccess:${serviceAccount}`, async () => {
    const have = secrets(ctx).names;
    if (!have) return { ok: false, missing: [], why: secrets(ctx).why };
    const names = [...CORE_SECRETS.map((s) => s.name), WEB_API_KEY_SECRET.name].filter((n) => have.has(n));
    if (!names.length) return { ok: true, missing: [], why: "" };
    const r = await secretsReadableBy(ctx.project, names, serviceAccount);
    return r.ok ? { ok: true, missing: names.filter((n) => !r.readable.has(n)), why: "" } : { ok: false, missing: [], why: r.why };
  });
}

/** The app's https origin: --app-url, else the backend's URL once it exists. */
export function appUrl(ctx) {
  if (ctx.flags.appUrl) return ctx.flags.appUrl;
  const b = backend(ctx);
  return b && b.uri ? b.uri.replace(/\/+$/, "") : "";
}

/**
 * Why the backend list failed, or "" when it worked (or --app-url makes it moot). The list goes
 * through the Firebase CLI, whose sign-in can lapse while gcloud's still works: then the backend
 * exists, but its address can't be read.
 */
function backendListFailure(ctx) {
  if (ctx.flags.appUrl) return "";
  const r = backends(ctx);
  return r.ok ? "" : r.why || "the Firebase CLI gave no reason";
}

/**
 * A check's `next` when a Firebase CLI list failed: signing it in again when that is the reason,
 * else nothing, so the plan names the step, whose stop gives the reason and the way on.
 * @param {string} why
 */
const firebaseNext = (why) => (isFirebaseSignInFailure(why) ? { next: FIREBASE_REAUTH } : {});

/** A check's answer when appUrl(ctx) is empty: can't tell when the list failed, else `waiting`. */
function waitsForBackend(ctx, waiting) {
  const why = backendListFailure(ctx);
  if (why) return unknown(`Can't list App Hosting backends, so the app's address isn't known: ${why}`, firebaseNext(why));
  return todo(waiting);
}

/**
 * What to do after a failed backend list: sign the Firebase CLI in again when that is the reason
 * (it often lapses), else fix the reason given (an API that is off, an account without access).
 * @param {string} why
 */
function backendListWayOn(why) {
  return isFirebaseSignInFailure(why) ? `sign the Firebase CLI in again (${FIREBASE_REAUTH}) and run this again` : "fix what it says and run this again";
}

const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The stop for a step that needs the backend itself (not only its address) when the list failed. */
function backendListStop(ctx) {
  const why = backends(ctx).why || "the Firebase CLI gave no reason";
  return fail([`Can't list App Hosting backends: ${why}`, `${upperFirst(backendListWayOn(why))}.`]);
}

/**
 * The stop for a step that needs the app's address when appUrl(ctx) is empty. When the backend
 * list itself failed, it says so with its reason and the two ways on (--app-url, or the fix for
 * the reason, usually signing the Firebase CLI in again); "No backend yet" only when the list
 * worked and has no backend.
 * @param {any} ctx
 * @param {string} stepId the step to run again
 * @param {string} [because] what the address is for, after "No backend yet"
 */
function noAppUrl(ctx, stepId, because = "") {
  const why = backendListFailure(ctx);
  if (why) {
    return fail([
      `Can't list App Hosting backends, so the app's address isn't known: ${why}`,
      `Either pass the app's https address: ${selfhostCommand(ctx, `--apply ${stepId} --app-url https://<your-app-host>`)}`,
      `Or ${backendListWayOn(why)}.`,
    ]);
  }
  return fail(`No backend yet${because}. Run: ${selfhostCommand(ctx, "--apply backend")}`);
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

/** The search databases this project needs: one per region whose own database exists, where it is. */
function searchDatabasesFor(ctx) {
  return SEARCH_DATABASES.filter((s) => firestoreDb(ctx, s.needs).ok).map((s) => ({
    ...s,
    location: s.location ?? firestoreDb(ctx, "(default)").data?.locationId ?? DEFAULT_FIRESTORE_LOCATION,
  }));
}

/** A search database that exists, is Enterprise and lets the Firestore API in. */
function searchDbReady(ctx, database) {
  const r = firestoreDb(ctx, database);
  return Boolean(r.ok && r.data?.databaseEdition === "ENTERPRISE" && r.data?.firestoreDataAccessMode === "DATA_ACCESS_MODE_ENABLED");
}

/** Which of the two search indexes a search database already has. */
function searchIndexesPresent(ctx, database) {
  const r = gcloudJson(["beta", "firestore", "indexes", "composite", "list", `--database=${database}`, `--project=${ctx.project}`]);
  const list = r.ok && Array.isArray(r.data) ? r.data : [];
  const onGroup = list.filter((i) => String(i.name ?? "").includes(`/collectionGroups/${SEARCH_COLLECTION_GROUP}/`));
  const has = (pred) => onGroup.some((i) => (i.fields ?? []).some(pred));
  return { text: has((f) => f.searchConfig), vector: has((f) => f.vectorConfig) };
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
        return unknown(`Can't list Firebase apps: ${r.why}`, { next: FIREBASE_REAUTH });
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
      // The workspace is made even when its organisation isn't; the warning names the repair.
      if (r.data.warning) ctx.say(`  ${r.data.warning}`);
      return ok();
    },
  },
  {
    id: "backend",
    title: "Create the App Hosting backend and give it access",
    async check(ctx) {
      const r = backends(ctx);
      if (!r.ok) return unknown(`Can't list App Hosting backends: ${r.why}`, firebaseNext(r.why));
      const b = backend(ctx);
      if (!b) return todo(`No App Hosting backend "${ctx.backendId}" yet.`);
      if (b.environment !== ctx.envName) return todo(`Backend ${b.id} exists, but its environment name is "${b.environment || "(none)"}", not "${ctx.envName}".`);
      const access = await secretsWithoutAccess(ctx, b.serviceAccount || runtimeServiceAccount(ctx.project));
      if (!access.ok) return unknown(`Can't read which secrets the backend may use: ${access.why}`);
      ctx.state.secretsWithoutAccess = access.missing;
      if (access.missing.length) {
        return todo(`Backend ${b.id} can't read ${access.missing.length} of the app's secrets yet: ${access.missing.join(", ")}. A rollout that names one fails with "Error resolving secret version".`);
      }
      return done(`${b.uri}, environment "${b.environment}", ${b.repository ? "rolls out from GitHub" : "deploys from this folder"}`);
    },
    changes(ctx) {
      const b = backend(ctx);
      // A failed list: apply() stops with the reason, so there is nothing to ask about.
      if (b === undefined) return [];
      const sa = (b && b.serviceAccount) || runtimeServiceAccount(ctx.project);
      const added = ctx.state.secretsWithoutAccess ?? [];
      return [
        ...(b ? [] : [`Create the App Hosting backend "${ctx.backendId}" in ${ctx.region}, linked to the web app`]),
        ...RUNTIME_ROLES.map((r) => `Grant ${sa} ${r.role} (${r.why})`),
        `Grant ${sa} roles/storage.objectUser on gs://${assetBucketName(ctx.project)}`,
        b && added.length
          ? `Give the backend access to the app's secrets, including ${added.length} added since it was set up: ${added.join(", ")} (firebase apphosting:secrets:grantaccess)`
          : "Give the backend access to the app's secrets (firebase apphosting:secrets:grantaccess)",
        `Set the backend's environment name to "${ctx.envName}", so it reads apphosting.${ctx.envName}.yaml`,
      ];
    },
    async apply(ctx) {
      let b = backend(ctx);
      // A failed list isn't "no backend": creating one then could clash with the one there.
      if (b === undefined) return backendListStop(ctx);
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
      "Turn on Firestore TTL clean-up for old events, drafts and sign-in codes on (default) (infra/lifecycle/setup.sh ttl)",
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
      if (!appUrl(ctx)) return noAppUrl(ctx, "envfile", ", so the app's address isn't known");
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
      if (!url) return waitsForBackend(ctx, "Waits for the backend (its address is the domain to authorise).");
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
      // A failed backend list: give its reason and the ways on, not console steps for no host.
      if (!url && backendListFailure(ctx)) return noAppUrl(ctx, "signin");
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
      if (!url) return waitsForBackend(ctx, "Waits for the backend (the jobs call its address).");
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
      if (!url) return noAppUrl(ctx, "scheduler");
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
      if (!url) return waitsForBackend(ctx, "Waits for the backend.");
      const h = await health(url);
      return h.ok ? done(`${url}/api/health answers`) : todo(`${url} isn't answering yet (${h.why}).`);
    },
    changes(ctx) {
      const b = backend(ctx);
      // A failed list: apply() stops with the reason, so there is nothing to ask about.
      if (b === undefined) return [];
      return [
        b && b.repository
          ? `Start a rollout of backend ${ctx.backendId} from the ${ctx.branch} branch on GitHub`
          : `Upload this folder and roll it out to backend ${ctx.backendId} (local source deploy; .gitignore'd files stay here)`,
        `Then check ${appUrl(ctx) || "the app"}/api/health`,
      ];
    },
    async apply(ctx) {
      const b = backend(ctx);
      if (b === undefined) return backendListStop(ctx);
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

// ---------------------------------------------------------------------------
// Email and password sign-in (addon:password)
// ---------------------------------------------------------------------------

/** Base URLs of the Logging and Monitoring APIs (overridable for tests). */
const loggingBase = () => (process.env.SELFHOST_LOGGING_URL || "https://logging.googleapis.com").replace(/\/+$/, "");
const monitoringBase = () => (process.env.SELFHOST_MONITORING_URL || "https://monitoring.googleapis.com").replace(/\/+$/, "");
const serviceUsageBase = () => (process.env.SELFHOST_SERVICEUSAGE_URL || "https://serviceusage.googleapis.com").replace(/\/+$/, "");

/** The role Google's reCAPTCHA guide gives Identity Platform's own service agent. */
const IDENTITY_AGENT_ROLE = "roles/identitytoolkit.serviceAgent";

/** Identity Platform's service agent, from the project number. */
function identityAgentEmail(projectNumber) {
  return `service-${projectNumber}@gcp-sa-identitytoolkit.iam.gserviceaccount.com`;
}

/**
 * Make Identity Platform's service agent and give it its role, as Google's reCAPTCHA guide asks
 * for every project. Without them Identity Platform can't make the reCAPTCHA keys, and password
 * sign-ins go through unscored while the config still says audit or enforce. Both are safe to
 * repeat. True when both worked.
 */
async function ensureIdentityAgent(ctx) {
  const line = (good, label, why = "") => ctx.say(`  ${good ? "ok  " : "fail"} ${label}${good ? "" : `: ${why}`}`);
  const info = projectInfo(ctx);
  if (info.state !== "ok" || !info.projectNumber) {
    line(false, "Identity Platform's service agent", info.why ?? "the project number isn't known");
    return false;
  }
  const r = await rest(`${serviceUsageBase()}/v1beta1/projects/${info.projectNumber}/services/identitytoolkit.googleapis.com:generateServiceIdentity`, ctx.project, {
    method: "POST",
    body: {},
  });
  const agent = String(r.data?.response?.email ?? "") || identityAgentEmail(info.projectNumber);
  line(r.ok, `Identity Platform's service agent ${agent}`, r.why);
  if (!r.ok) return false;
  // IAM can take a few seconds to know an agent made a moment ago: the first grant may fail with
  // "Policy modification failed" and the same grant work seconds later. Try again, waiting longer.
  const label = `${IDENTITY_AGENT_ROLE} for ${agent}`;
  const args = ["projects", "add-iam-policy-binding", ctx.project, `--member=serviceAccount:${agent}`, `--role=${IDENTITY_AGENT_ROLE}`, "--condition=None"];
  const waits = retryWaitsMs();
  for (let i = 0; ; i++) {
    const g = capture("gcloud", args, { cwd: ctx.repoRoot });
    if (g.ok) {
      line(true, label);
      return true;
    }
    if (i >= waits.length) {
      line(false, `${label} (tried ${i + 1} times)`, reason(g));
      // The usual cause: IAM doesn't know the agent made a moment ago yet. Waiting fixes that.
      if (NOT_FOUND.test(reason(g))) ctx.say("  IAM doesn't know the new service agent yet. Run this add-on again in a minute.");
      return false;
    }
    ctx.say(`  wait ${label}: ${reason(g)}; trying again in ${Math.round(waits[i] / 1000)}s`);
    await sleep(waits[i]);
  }
}

/** The waits between tries of a call that a change made a moment ago can briefly refuse. */
const RETRY_WAITS_MS = [5_000, 10_000, 20_000];

/** RETRY_WAITS_MS, or each one SELFHOST_RETRY_WAIT_MS long (tests set it near zero). */
function retryWaitsMs() {
  const override = process.env.SELFHOST_RETRY_WAIT_MS;
  return override !== undefined && override !== "" && Number.isFinite(Number(override)) ? RETRY_WAITS_MS.map(() => Number(override)) : RETRY_WAITS_MS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const identityConfigUrl = (ctx) => `${identityToolkitBase()}/admin/v2/projects/${ctx.project}/config`;
/** The project's Identity Toolkit config (admin v2), read once per check. */
const identityConfig = (ctx) => memo(ctx, "identityConfig", () => rest(identityConfigUrl(ctx), ctx.project));

/** Whether the settings file names an email provider (addon:email), so a code can reach an inbox. */
function hasEmailProvider(ctx) {
  const e = entryMap(envText(ctx));
  return e.has("MANDRILL_API_KEY") || e.has("RESEND_API_KEY");
}

/** Who the sign-in alerts email: --alert-email, else the first address on ADMIN_ALLOWED_EMAILS. */
function alertEmail(ctx) {
  const chosen = ctx.flags?.alertEmail?.trim();
  if (chosen) return chosen;
  return envValue(ctx, "ADMIN_ALLOWED_EMAILS").split(",").map((s) => s.trim()).find(Boolean) ?? "";
}

/** "a", "a and b", "a, b and c". */
function andList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");
}

/** Every page of a list call (Monitoring's alert policies or channels). { ok, items, why }. */
async function listAll(ctx, url, field) {
  const items = [];
  let token = "";
  for (let page = 0; page < 10; page++) {
    const r = await rest(`${url}?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, ctx.project);
    if (!r.ok) return { ok: false, items, why: r.why };
    items.push(...(Array.isArray(r.data?.[field]) ? r.data[field] : []));
    token = String(r.data?.nextPageToken ?? "");
    if (!token) break;
  }
  return { ok: true, items, why: "" };
}

/**
 * Which of the sign-in alerts are missing: the log metrics by name, the alert policies by display
 * name. Without Identity Platform (plain Firebase Authentication) the sign-up metric and alert
 * aren't wanted. Read only. { ok, missing, why }.
 * @param {any} ctx
 * @param {boolean} identityPlatform
 */
function authAlertsState(ctx, identityPlatform) {
  return memo(ctx, `authAlerts:${identityPlatform}`, async () => {
    const missing = [];
    for (const m of authLogMetricsFor(identityPlatform)) {
      const r = await rest(`${loggingBase()}/v2/projects/${ctx.project}/metrics/${m.name}`, ctx.project);
      if (r.status === 404) missing.push(`log metric ${m.name}`);
      else if (!r.ok) return { ok: false, missing: [], why: r.why };
    }
    const policies = await listAll(ctx, `${monitoringBase()}/v3/projects/${ctx.project}/alertPolicies`, "alertPolicies");
    if (!policies.ok) return { ok: false, missing: [], why: policies.why };
    const names = new Set(policies.items.map((p) => p.displayName));
    for (const p of authAlertPoliciesFor([], identityPlatform)) if (!names.has(p.displayName)) missing.push(`alert "${p.displayName}"`);
    return { ok: true, missing, why: "" };
  });
}

/**
 * Make the log metrics, the alert policies, and an email channel for the alerts' recipient
 * (alertEmail) when a policy is made. Each is made only when missing (a metric whose filter
 * changed is updated); an alert policy that exists is left as its owner may have changed it,
 * recipients included, so a copy that has the older alerts gets only the new one. True when all
 * are there. Without Identity Platform the sign-up metric and alert are left out.
 * @param {any} ctx
 * @param {boolean} identityPlatform
 */
async function ensureAuthAlerts(ctx, identityPlatform) {
  const p = ctx.project;
  const line = (good, label, why = "") => ctx.say(`  ${good ? "ok  " : "fail"} ${label}${good ? "" : `: ${why}`}`);
  const metrics = `${loggingBase()}/v2/projects/${p}/metrics`;
  for (const m of authLogMetricsFor(identityPlatform)) {
    const got = await rest(`${metrics}/${m.name}`, p);
    if (got.ok && got.data?.filter === m.filter) {
      line(true, `log metric ${m.name} (already there)`);
      continue;
    }
    if (!got.ok && got.status !== 404) {
      line(false, `log metric ${m.name}`, got.why);
      return false;
    }
    const r = got.ok ? await rest(`${metrics}/${m.name}`, p, { method: "PUT", body: logMetricBody(m) }) : await rest(metrics, p, { method: "POST", body: logMetricBody(m) });
    line(r.ok, `log metric ${m.name}${got.ok ? " (filter updated)" : ""}`, r.why);
    if (!r.ok) return false;
  }

  const policiesUrl = `${monitoringBase()}/v3/projects/${p}/alertPolicies`;
  const existing = await listAll(ctx, policiesUrl, "alertPolicies");
  if (!existing.ok) {
    line(false, "alert policies", existing.why);
    return false;
  }
  const names = new Set(existing.items.map((x) => x.displayName));
  const toMake = authAlertPoliciesFor([], identityPlatform).filter((policy) => !names.has(policy.displayName));

  // A channel only for alerts made now: alerts already there keep the recipients they have.
  let channels = [];
  const email = alertEmail(ctx);
  if (!toMake.length) {
    line(true, "the alerts are already there and keep their recipients");
  } else if (email) {
    const url = `${monitoringBase()}/v3/projects/${p}/notificationChannels`;
    const list = await listAll(ctx, url, "notificationChannels");
    if (!list.ok) {
      line(false, "notification channels", list.why);
      return false;
    }
    const found = list.items.find((c) => c.type === "email" && String(c.labels?.email_address ?? "").toLowerCase() === email.toLowerCase());
    if (found) {
      channels = [found.name];
      line(true, `new alerts go to ${email} (its channel is already there)`);
    } else {
      const r = await rest(url, p, { method: "POST", body: { type: "email", displayName: "YouGrow sign-in alerts", labels: { email_address: email } } });
      line(r.ok, `new alerts go to ${email}`, r.why);
      if (!r.ok) return false;
      channels = [r.data?.name].filter(Boolean);
    }
  }

  for (const policy of authAlertPoliciesFor(channels, identityPlatform)) {
    if (names.has(policy.displayName)) {
      line(true, `alert "${policy.displayName}" (already there, left as it is)`);
      continue;
    }
    let r = await rest(policiesUrl, p, { method: "POST", body: policy });
    // A log metric made a moment ago can take a few seconds to be known to Monitoring.
    for (let i = 0; i < 2 && !r.ok && /metric/i.test(r.why); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      r = await rest(policiesUrl, p, { method: "POST", body: policy });
    }
    line(r.ok, `alert "${policy.displayName}"`, r.why);
    if (!r.ok) return false;
  }
  return true;
}

/** The add-on's state from a read of the config and the alerts, kept for changes() and apply(). */
async function passwordState(ctx) {
  const cfg = await identityConfig(ctx);
  if (!cfg.ok) return { ok: false, why: cfg.why };
  const config = cfg.data ?? {};
  // Plain Firebase Authentication refuses request logging. The upgrade is opt-in only
  // (--upgrade-identity-platform): with it, plan as for the upgraded project apply() makes.
  const plain = isPlainFirebaseAuth(config);
  const upgrade = plain && Boolean(ctx.flags?.upgradeIdentityPlatform);
  const identityPlatform = !plain || upgrade;
  const diff = passwordConfigDiff(upgrade ? { ...config, subtype: "IDENTITY_PLATFORM" } : config, appUrl(ctx));
  const alerts = await authAlertsState(ctx, identityPlatform);
  const state = {
    ok: true,
    diff,
    config,
    plain,
    upgrade,
    identityPlatform,
    alerts,
    switchOn: envValue(ctx, "PASSWORD_SIGNIN_ENABLED") === "true",
    emailProvider: hasEmailProvider(ctx),
  };
  ctx.state.password = state;
  return state;
}

/**
 * Upgrade the project to Firebase Authentication with Identity Platform (identityPlatform:
 * initializeAuth; only on --upgrade-identity-platform, as it can't be undone), then read the
 * config back until it says IDENTITY_PLATFORM. { ok, config } or { ok: false, detail }.
 */
async function upgradeToIdentityPlatform(ctx) {
  const r = await rest(`${identityToolkitBase()}/v2/projects/${ctx.project}/identityPlatform:initializeAuth`, ctx.project, { method: "POST", body: {} });
  ctx.say(`  ${r.ok ? "ok  " : "fail"} upgrade to Firebase Authentication with Identity Platform${r.ok ? "" : `: ${r.why}`}`);
  if (!r.ok) {
    // A timeout, a dropped connection or a server error may come after the upgrade went through,
    // so read the config back once before saying what happened.
    ctx.memo.delete("identityConfig");
    const back = await identityConfig(ctx);
    if (back.ok && String(back.data?.subtype ?? "") === "IDENTITY_PLATFORM") {
      ctx.say("  ok   read back: the project is on Identity Platform");
      return { ok: true, config: back.data };
    }
    const again = selfhostCommand(ctx, "--apply addon:password --upgrade-identity-platform");
    const without = "Or run it without --upgrade-identity-platform: everything but request logging and the sign-ups alert goes on.";
    if (r.status === 0 || r.status >= 500) {
      return {
        ok: false,
        detail: [
          `The upgrade to Identity Platform didn't answer clearly (${r.why}), so it may or may not have happened. No sign-in setting was changed.`,
          `Run this again to find out and finish: ${again}`,
          without,
        ],
      };
    }
    return {
      ok: false,
      detail: [
        `The upgrade to Identity Platform was refused (${r.why}), so no sign-in setting was changed.`,
        ...(/billing/i.test(r.why) ? ["It needs billing on the project (the Blaze plan)."] : []),
        `Fix what it says, then run this again: ${again}`,
        without,
      ],
    };
  }
  const waits = retryWaitsMs();
  for (let i = 0; ; i++) {
    ctx.memo.delete("identityConfig");
    const back = await identityConfig(ctx);
    const subtype = String(back.data?.subtype ?? "");
    if (back.ok && subtype === "IDENTITY_PLATFORM") {
      ctx.say("  ok   read back: the project is on Identity Platform");
      return { ok: true, config: back.data };
    }
    if (i >= waits.length) {
      return {
        ok: false,
        detail: [
          back.ok
            ? `The upgrade was accepted, but the project still says ${subtype || "no subtype"}, so no sign-in setting was changed.`
            : `The upgrade was accepted, but the sign-in settings can't be read back (${back.why}), so none was changed.`,
          "Run this add-on again in a minute.",
        ],
      };
    }
    await sleep(waits[i]);
  }
}

/** The closing lines on plain Firebase Authentication without the upgrade: what was left out and how to add it. */
function upgradeSkippedLines(ctx) {
  return [
    "Left out: request logging and the \"YouGrow: many password sign-ups\" alert. Both need the Identity Platform",
    "upgrade, which is free up to 50,000 monthly active users, then charged per user, and can't be undone.",
    `To add them later: ${selfhostCommand(ctx, "--apply addon:password --upgrade-identity-platform")}`,
  ];
}

/** The collections holding sign-in codes, their per-address guards and the links sent in place of a code, each with a `ttl` field. */
const CODE_TTL_COLLECTIONS = ["email_codes", "email_code_guards", "email_confirm_links"];

const EMAIL_PROVIDER_NOTE = [
  "Note: password sign-in needs an email provider for its confirmation codes (MANDRILL_API_KEY or",
  "RESEND_API_KEY in your settings file). Without one the sign-in page keeps offering Google only.",
  "Add one with addon:email.",
];

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
      if (!appUrl(ctx)) return noAppUrl(ctx, "addon:vizzy");
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
      if (!appUrl(ctx)) return noAppUrl(ctx, "addon:github-app");
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
        if (!appUrl(ctx)) return noAppUrl(ctx, `addon:${network}`);
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
    id: "addon:search",
    title: "Brand search: find what a brand wrote by words and meaning",
    how: "automated; uses gcloud beta for the text indexes",
    check(ctx) {
      const wanted = searchDatabasesFor(ctx);
      const missing = wanted.filter((s) => !searchDbReady(ctx, s.database));
      if (missing.length) return todo(`missing: ${missing.map((s) => s.database).join(", ")}`);
      if (envValue(ctx, "SEARCH_INDEX_ENABLED") !== "true") return todo("databases ready; switches off");
      // An index from before the brand map family (ADR-0023): run this again to turn it on, then the backfill.
      if (envValue(ctx, "SEARCH_FAMILY_INDEX_ENABLED") !== "true") return todo("index on; SEARCH_FAMILY_INDEX_ENABLED off: run this again, then the backfill with --all-brands");
      return done(wanted.map((s) => s.database).join(", "));
    },
    changes: (ctx) => {
      const wanted = searchDatabasesFor(ctx);
      return [
        `Create Firestore Enterprise databases ${wanted.map((s) => `${s.database} (${s.location})`).join(", ")}: each bills on its own, by data read and written, and its location is permanent`,
        `Create a words index (title, text) and a meaning index (embedding, ${SEARCH_VECTOR_DIM} numbers) on ${SEARCH_COLLECTION_GROUP} in each`,
        `Turn on ${switchesForAddon("search").length} search switches in apphosting.${ctx.envName}.yaml (reranking stays off; docs/self-host.md says how to turn it on)`,
        "Fill the index for every brand afterwards: npx tsx scripts/search-backfill.ts --all-brands (a dry run first)",
      ];
    },
    async apply(ctx) {
      for (const s of searchDatabasesFor(ctx)) {
        const args = searchDatabaseArgs(ctx.project, s.database, s.location);
        const existing = firestoreDb(ctx, s.database);
        if (existing.ok && !searchDbReady(ctx, s.database)) {
          return fail(`${s.database} exists but isn't an Enterprise database with Firestore access on. Delete it (it holds only the index) and run this again.`);
        }
        if (!existing.ok) {
          const code = await runLive(ctx, "gcloud", args.create);
          if (code !== 0) return fail(`Creating ${s.database} failed (see above).`);
        }
        const present = searchIndexesPresent(ctx, s.database);
        if (!present.text) {
          const code = await runLive(ctx, "gcloud", args.textIndex);
          if (code !== 0) return fail(`Creating the words index on ${s.database} failed (see above). It needs the gcloud beta component: gcloud components install beta`);
        }
        if (!present.vector) {
          const code = await runLive(ctx, "gcloud", args.vectorIndex);
          if (code !== 0) return fail(`Creating the meaning index on ${s.database} failed (see above).`);
        }
      }
      ctx.say("  The indexes build in the background (a few minutes). Search finds nothing until they are ready.");
      return setForAddon(ctx, "search", []);
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
      if (!appUrl(ctx)) return noAppUrl(ctx, "addon:recaptcha");
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
  {
    id: "addon:password",
    title: "Turn on email and password sign-in",
    how: "automated; needs an email provider (addon:email) for the confirmation codes",
    async check(ctx) {
      const s = await passwordState(ctx);
      if (!s.ok) return unknown(`Can't read the sign-in settings: ${s.why}`);
      const missing = [
        ...(s.upgrade ? ["the project is on Firebase Authentication without the Identity Platform upgrade"] : []),
        ...s.diff.filter((d) => d.level !== "info").map((d) => d.what),
        ...(s.alerts.ok ? s.alerts.missing.map((a) => `no ${a}`) : [`the sign-in alerts can't be read (${s.alerts.why})`]),
        ...(s.switchOn ? [] : ["PASSWORD_SIGNIN_ENABLED is off"]),
      ];
      const notes = [
        ...s.diff.filter((d) => d.level === "info").map((d) => d.what),
        ...(s.emailProvider ? [] : ["no email provider yet (addon:email), so nobody gets a code"]),
        // Plain Firebase Authentication: not missing, a choice. Say what it lacks and how to opt in.
        ...(s.plain && !s.upgrade ? [`${NEEDS_UPGRADE_NOTE} (run addon:password with --upgrade-identity-platform to opt in)`] : []),
      ];
      const also = notes.length ? `. Also: ${notes.join("; ")}` : "";
      if (missing.length) return todo(`${missing.join("; ")}${also}.`);
      const bots = s.config.recaptchaConfig?.emailPasswordEnforcementState;
      return done(`Email/Password on, ${PASSWORD_MIN_LENGTH} characters or more, reCAPTCHA ${bots === "ENFORCE" ? "enforced" : "in audit mode"}, alerts set${also}`);
    },
    async inputs(ctx) {
      if (!existsSync(ctx.envFile)) return fail(`No apphosting.${ctx.envName}.yaml yet. Run the core steps first: ${selfhostCommand(ctx, "--apply core")}`);
      if (!appUrl(ctx)) return noAppUrl(ctx, "addon:password", ", so the reset link's address isn't known");
      const s = ctx.state.password ?? (await passwordState(ctx));
      if (!s.ok) return fail(`Can't read the sign-in settings: ${s.why}`);
      if (!s.emailProvider) for (const line of EMAIL_PROVIDER_NOTE) ctx.say(`  ${line}`);
      return ok();
    },
    changes(ctx) {
      const s = ctx.state.password;
      const apis = enabledApis(ctx.project);
      const needApis = PASSWORD_APIS.filter((a) => !apis.apis || !apis.apis.has(a.id));
      ctx.state.passwordApis = needApis;
      const email = alertEmail(ctx);
      const policies = authAlertPoliciesFor([], s.identityPlatform);
      return [
        // Listed first: it is the one change that can't be undone.
        ...(s.upgrade ? [`${IDENTITY_PLATFORM_UPGRADE} (identityPlatform:initializeAuth, before any Identity Platform setting below; needs billing on the project)`] : []),
        ...(needApis.length ? [`Turn on ${needApis.map((a) => `${a.id} (${a.why})`).join(", ")}`] : []),
        ...passwordPatchPlan(s.diff).map(
          (b) => `Identity Platform, ${b.label}: ${b.items.map((d) => d.fix).join("; ")} (one PATCH, updateMask ${b.mask}${b.soft ? "; a refusal only warns" : ""})`,
        ),
        ...(s.diff.some((d) => d.batch === "provider") ? ["The Email/Password provider goes on last, after every protection above"] : []),
        `Make Identity Platform's service agent and give it ${IDENTITY_AGENT_ROLE}, so reCAPTCHA can make its keys (safe to repeat)`,
        `Turn on Firestore TTL clean-up for sign-in codes on (default): ${andList(CODE_TTL_COLLECTIONS)} (safe to repeat; copies set up before these existed lack it)`,
        ...(!s.alerts.ok || s.alerts.missing.length
          ? [
              `Make the sign-in alerts where missing: log metrics ${andList(authLogMetricsFor(s.identityPlatform).map((m) => m.name))}, and alerts ${andList(policies.map((p) => `"${p.displayName}"`))}${email ? `, emailed to ${email}` : ""}`,
            ]
          : []),
        ...(s.plain && !s.upgrade
          ? [
              "Leave out request logging and the many password sign-ups alert: this project is on Firebase Authentication without the Identity Platform upgrade (add --upgrade-identity-platform to opt in)",
            ]
          : []),
        // apply() only writes the switch when it is off and there is an email provider.
        ...(s.switchOn
          ? []
          : [
              s.emailProvider
                ? `Turn on PASSWORD_SIGNIN_ENABLED in apphosting.${ctx.envName}.yaml`
                : `Leave PASSWORD_SIGNIN_ENABLED off in apphosting.${ctx.envName}.yaml: no email provider yet (addon:email)`,
            ]),
      ];
    },
    async apply(ctx) {
      const s = ctx.state.password;
      const needApis = ctx.state.passwordApis ?? PASSWORD_APIS;
      if (needApis.length) {
        const code = await runLive(ctx, "gcloud", ["services", "enable", ...needApis.map((a) => a.id), `--project=${ctx.project}`]);
        if (code !== 0) return fail("Turning on the APIs failed (see above).");
      }
      // reCAPTCHA's keys are made by Identity Platform's service agent: it comes before the config.
      if (!(await ensureIdentityAgent(ctx))) {
        return fail([
          "Making Identity Platform's service agent failed (see above). Without it reCAPTCHA has no keys and scores nothing.",
          "Nothing in Identity Platform was changed. Fix what it says and run this add-on again.",
        ]);
      }
      // The codes' own clean-up. The core step's TTL run covers them on new copies; a copy set up
      // before they existed never re-runs it, so turn it on here too (the same command, repeatable).
      for (const group of CODE_TTL_COLLECTIONS) {
        const args = ["firestore", "fields", "ttls", "update", "ttl", `--collection-group=${group}`, "--enable-ttl", "--database=(default)", `--project=${ctx.project}`, "--async"];
        const code = await runLive(ctx, "gcloud", args);
        if (code !== 0) return fail(`Turning on the TTL clean-up for ${group} failed (see above). Nothing in Identity Platform was changed.`);
      }
      // The opt-in upgrade, before any setting changes; then plan from what the project now says.
      let diff = s.diff;
      if (s.upgrade) {
        const up = await upgradeToIdentityPlatform(ctx);
        if (!up.ok) return fail(up.detail);
        diff = passwordConfigDiff(up.config, appUrl(ctx));
      }
      const warnings = [];
      const plan = passwordPatchPlan(diff);
      for (const [i, batch] of plan.entries()) {
        const r = await rest(`${identityConfigUrl(ctx)}?updateMask=${encodeURIComponent(batch.mask)}`, ctx.project, { method: "PATCH", body: batch.body });
        ctx.say(`  ${r.ok ? "ok  " : batch.soft ? "warn" : "fail"} ${batch.label} (${batch.mask})${r.ok ? "" : `: ${r.why}`}`);
        if (r.ok) continue;
        if (batch.soft) {
          warnings.push(
            `Identity Platform refused the reset link's address. Set it by hand: Firebase console, Authentication, Templates, Password reset, edit, Customize action URL: ${appUrl(ctx)}/auth/reset`,
          );
          continue;
        }
        const left = plan.slice(i + 1);
        return fail([
          `Identity Platform refused the ${batch.label}. Nothing after it was sent${left.length ? ` (${left.map((b) => b.label).join(", ")})` : ""}, so the Email/Password provider stays as it was.`,
          `Fix what it says, or set it in the Firebase console: https://console.firebase.google.com/project/${ctx.project}/authentication/settings`,
        ]);
      }

      // Read back what Identity Platform kept.
      ctx.memo.clear();
      const back = await identityConfig(ctx);
      if (!back.ok) return fail(`Can't read the sign-in settings back: ${back.why}`);
      const left = passwordConfigDiff(back.data ?? {}, appUrl(ctx)).filter((d) => d.level !== "info");
      if (left.length) return fail(`Identity Platform still differs after the changes: ${left.map((d) => d.what).join("; ")}.`);
      ctx.say(`  ok   read back: Email/Password on, ${PASSWORD_MIN_LENGTH} characters or more, protections on`);

      if (!(await ensureAuthAlerts(ctx, s.identityPlatform))) {
        return fail([
          "Making the sign-in alerts failed (see above). Identity Platform is set; run this add-on again to finish the alerts.",
          // A copy that already has password sign-in on re-runs this for a newer alert: it stays on.
          s.switchOn
            ? `PASSWORD_SIGNIN_ENABLED is still on in apphosting.${ctx.envName}.yaml, as it was: only the alerts are unfinished.`
            : `PASSWORD_SIGNIN_ENABLED is still off in apphosting.${ctx.envName}.yaml.`,
        ]);
      }

      // No email provider, no codes: the sign-in page would offer Google only while the help page
      // and Settings describe passwords. Leave the switch off; the check keeps the add-on to do.
      // Without the upgrade, the closing lines say what was left out and how to add it later.
      const skipped = s.plain && !s.upgrade ? upgradeSkippedLines(ctx) : [];
      const saySkipped = () => {
        for (const l of skipped) ctx.say(`  ${l}`);
      };
      if (!hasEmailProvider(ctx)) {
        for (const w of warnings) ctx.say(`  Warning: ${w}`);
        // A copy whose switch is already on (its provider removed since) keeps it: say so, not "stays off".
        if (s.switchOn) {
          ctx.say(`  Identity Platform and the alerts are ready. PASSWORD_SIGNIN_ENABLED is on in apphosting.${ctx.envName}.yaml,`);
          ctx.say("  but nobody gets a confirmation code until there is an email provider (MANDRILL_API_KEY or RESEND_API_KEY).");
          ctx.say(`  Run ${selfhostCommand(ctx, "--apply addon:email")} to add one.`);
          saySkipped();
          return ok();
        }
        ctx.say("  Identity Platform and the alerts are ready. PASSWORD_SIGNIN_ENABLED stays off: password sign-in");
        ctx.say("  needs an email provider for its confirmation codes (MANDRILL_API_KEY or RESEND_API_KEY).");
        ctx.say(`  Run ${selfhostCommand(ctx, "--apply addon:email")}, then this add-on again to turn it on.`);
        saySkipped();
        return ok();
      }
      const r = setForAddon(ctx, "password", []);
      for (const w of warnings) ctx.say(`  Warning: ${w}`);
      ctx.say("  reCAPTCHA starts in audit mode: it records, blocks nothing. After a week, if its metrics look right,");
      ctx.say("  set it to ENFORCE (docs/self-host.md, Email and password sign-in).");
      ctx.say("  Only addresses on ADMIN_ALLOWED_EMAILS can get in with a password; the domain list stays Google only.");
      saySkipped();
      return r;
    },
  },
];

export const ALL_STEPS = [...CORE_STEPS, ...ADDONS];
