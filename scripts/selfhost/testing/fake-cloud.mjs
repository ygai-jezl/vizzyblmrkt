#!/usr/bin/env node
// A stand-in for the gcloud and firebase CLIs in the selfhost tests. It keeps a small fake
// project in a JSON file (FAKE_CLOUD_STATE), answers the calls `npm run selfhost` and the infra
// scripts make, and records every call (FAKE_CLOUD_LOG, one JSON line each). Values sent on
// stdin to create a secret are recorded in FAKE_CLOUD_SECRETS, so a test can check none of
// them is ever printed. Never touches a real cloud.
//
//   node fake-cloud.mjs gcloud <args...>
//   node fake-cloud.mjs firebase <args...>
//   node fake-cloud.mjs workspace <args...>    (stands in for scripts/selfhost/create-workspace.ts)

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
const STATE = process.env.FAKE_CLOUD_STATE;
const state = JSON.parse(readFileSync(STATE, "utf8"));
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const stdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (...words) => words.every((w, i) => args[i] === w);
const out = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const json = (value) => out(JSON.stringify(value));
const err = (text, code = 1) => {
  process.stderr.write(`ERROR: (${tool}) ${text}\n`);
  process.exit(code);
};
const fbOk = (result) => json({ status: "success", result });
const fbErr = (error) => {
  json({ status: "error", error });
  process.exit(1);
};

appendFileSync(process.env.FAKE_CLOUD_LOG, `${JSON.stringify({ tool, args })}\n`);

function projectGuard() {
  const p = flag("project") ?? args.find((a) => a === state.project);
  if (!state.exists || (p && p !== state.project)) err(`[${state.account}] does not have permission to access projects instance [${p}] (or it may not exist)`);
}

function gcloud() {
  if (has("--version")) return out("Google Cloud SDK 999.0.0 (fake)");
  if (has("auth", "list")) return out(state.account ?? "");
  if (has("auth", "print-access-token")) return out("fake-access-token");
  if (has("config", "get-value", "account")) return out(state.account ?? "");
  if (has("projects", "describe")) {
    if (!state.exists || args[2] !== state.project) err(`[${state.account}] does not have permission to access projects instance [${args[2]}] (or it may not exist)`);
    return json({ projectId: state.project, projectNumber: "123456789012", lifecycleState: "ACTIVE", name: state.project });
  }
  projectGuard();
  if (has("billing", "projects", "describe")) return out(state.billing ? "True" : "False");
  if (has("services", "list")) return out((state.apis ?? []).join("\n"));
  if (has("services", "enable")) {
    state.apis = [...new Set([...(state.apis ?? []), ...args.slice(2).filter((a) => !a.startsWith("--"))])];
    return save();
  }
  if (has("secrets", "list")) return out((state.secrets ?? []).join("\n"));
  if (has("secrets", "create")) {
    const value = stdin();
    appendFileSync(process.env.FAKE_CLOUD_SECRETS, `${value}\n`);
    if ((state.secrets ?? []).includes(args[2])) err(`Secret [${args[2]}] already exists.`);
    state.secrets = [...(state.secrets ?? []), args[2]];
    return save();
  }
  if (has("secrets", "describe")) return (state.secrets ?? []).includes(args[2]) ? json({ name: args[2] }) : err(`NOT_FOUND: Secret [${args[2]}] not found`);
  if (has("secrets", "versions", "access")) return out(`fake-secret-value-of-${flag("secret")}`);
  if (has("firestore", "databases", "describe")) {
    const db = (state.databases ?? {})[flag("database") ?? "(default)"];
    return db ? json({ name: flag("database"), locationId: db, type: "FIRESTORE_NATIVE" }) : err(`NOT_FOUND: Database '${flag("database")}' does not exist.`);
  }
  if (has("firestore", "databases", "create")) {
    state.databases = { ...(state.databases ?? {}), [flag("database") ?? "(default)"]: flag("location") };
    return save();
  }
  if (has("firestore", "indexes", "composite", "list")) return json(state.indexesDeployed ? [{ name: "idx" }] : []);
  if (has("firestore", "fields", "ttls", "update")) return;
  if (has("storage", "buckets", "describe")) return (state.buckets ?? []).includes(args[3]) ? json({ name: args[3] }) : err(`NOT_FOUND: ${args[3]} not found: 404`);
  if (has("storage", "buckets", "create")) {
    state.buckets = [...(state.buckets ?? []), args[3]];
    return save();
  }
  if (has("kms", "keys", "describe")) return state.kmsKey ? json({ name: "outbound-signing" }) : err("NOT_FOUND: CryptoKey not found.");
  if (has("kms", "keys", "create")) {
    state.kmsKey = true;
    return save();
  }
  if (has("kms", "keyrings", "describe")) return state.keyring ? json({}) : err("NOT_FOUND: KeyRing not found.");
  if (has("kms", "keyrings", "create")) {
    state.keyring = true;
    return save();
  }
  if (has("apphosting")) err("Invalid choice: 'apphosting'.", 2);
  if (has("scheduler", "jobs", "list")) return json((state.jobs ?? []).map((j) => ({ name: `projects/${state.project}/locations/us-central1/jobs/${j.name}`, httpTarget: { uri: j.uri } })));
  if (has("scheduler", "jobs", "describe")) return (state.jobs ?? []).some((j) => j.name === args[3]) ? json({}) : err("NOT_FOUND: Job not found.");
  if (has("scheduler", "jobs", "create", "http") || has("scheduler", "jobs", "update", "http")) {
    state.jobs = [...(state.jobs ?? []).filter((j) => j.name !== args[4]), { name: args[4], uri: flag("uri") }];
    return save();
  }
  // add-iam-policy-binding and anything else: succeed quietly.
}

function firebase() {
  if (has("--version")) return out("15.27.0");
  const p = flag("project") ?? args[1];
  if (!state.exists || p !== state.project) fbErr(`Failed to get Firebase project ${p}. Please make sure the project exists and your account has permission to access it.`);
  if (has("apps:list")) return state.firebase ? fbOk(state.webApps ?? []) : fbErr("Failed to list Firebase WEB apps. See firebase-debug.log for more info.");
  if (has("projects:addfirebase")) {
    state.firebase = true;
    return save();
  }
  if (has("apps:create")) {
    state.webApps = [...(state.webApps ?? []), { appId: "1:123456789012:web:fake", displayName: args[2], platform: "WEB" }];
    return save();
  }
  if (has("apps:sdkconfig")) return fbOk({ sdkConfig: { projectId: state.project, apiKey: state.webApiKey, authDomain: `${state.project}.firebaseapp.com` } });
  if (has("apphosting:backends:list")) {
    return fbOk(
      (state.backends ?? []).map((b) => ({
        name: `projects/${state.project}/locations/${b.region}/backends/${b.id}`,
        uri: `${b.id}--${state.project}.${b.region}.hosted.app`,
        environment: b.environment ?? "",
        serviceAccount: `firebase-app-hosting-compute@${state.project}.iam.gserviceaccount.com`,
      })),
    );
  }
  if (has("apphosting:backends:create")) {
    state.backends = [...(state.backends ?? []), { id: flag("backend"), region: flag("primary-region"), environment: "" }];
    return save();
  }
  if (has("apphosting:secrets:grantaccess")) {
    state.granted = [...new Set([...(state.granted ?? []), ...args[1].split(",")])];
    return save();
  }
  if (has("deploy")) {
    const config = flag("config");
    if (config) {
      state.lastDeployConfig = JSON.parse(readFileSync(config.startsWith("/") ? config : `${process.cwd()}/${config}`, "utf8"));
      state.deployConfigs = [...(state.deployConfigs ?? []), state.lastDeployConfig];
    }
    if (flag("only") === "firestore") state.indexesDeployed = true;
    return save();
  }
}

function workspace() {
  if (args.includes("--list")) return json({ ok: true, tenants: state.tenants ?? [] });
  if ((state.tenants ?? []).length && !args.includes("--another")) return json({ ok: false, error: "A workspace already exists." });
  const name = flag("name");
  const id = `ten_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  state.tenants = [...(state.tenants ?? []), { id, name, region: flag("region") ?? "us" }];
  save();
  return json({ ok: true, created: true, id, name, region: flag("region") ?? "us" });
}

if (tool === "gcloud") gcloud();
else if (tool === "firebase") firebase();
else if (tool === "workspace") workspace();
else err(`unknown tool ${tool}`, 2);
