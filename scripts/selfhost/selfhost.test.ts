// npm run selfhost and npm run doctor -- --cloud against a fake gcloud and firebase on PATH
// (scripts/selfhost/testing/fake-cloud.mjs). Each test copies the scripts into a temp folder,
// so the env file and temporary configs are written there, never into this checkout.

import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSwitches, entryMap } from "./envfile.mjs";
import { CORE_SECRETS, KEPT_OFF, REQUIRED_APIS } from "./spec.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PROJECT = "acme-growth-test";
const WEB_API_KEY = "AIzaFakeWebKeyForTests0000000000000000";
/** These tests start real child processes; under a full parallel run they take longer. */
const SLOW = 60_000;

type State = Record<string, unknown> & {
  project: string;
  exists: boolean;
  account: string;
  billing: boolean;
};

/** What the test server keeps for the REST APIs, beside the fake CLIs' own state. */
type FakeCloudState = State & {
  backends?: { id: string; environment: string }[];
  firebase?: boolean;
  googleSignIn?: boolean;
  authorizedDomains?: string[];
  secrets?: string[];
  granted?: string[];
  /** Identity Toolkit's config (admin v2), less authorizedDomains. */
  identityConfig?: Record<string, unknown>;
  /** Each config PATCH's updateMask, in order. */
  patches?: string[];
  /** updateMask prefixes the project refuses. */
  refuseMasks?: string[];
  logMetrics?: Record<string, { name: string; filter: string }>;
  alertPolicies?: Record<string, unknown>[];
  notificationChannels?: Record<string, unknown>[];
  monitoringOff?: boolean;
  /** Services whose service agent was made (Service Usage generateServiceIdentity). */
  serviceIdentities?: string[];
};

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (!rest.length) return { ...obj, [head!]: value };
  const inner = obj[head!] && typeof obj[head!] === "object" ? (obj[head!] as Record<string, unknown>) : {};
  return { ...obj, [head!]: setPath(inner, rest.join("."), value) };
}

let dir = "";
let server: Server;
let port = 0;

function readState(): State {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}
function writeState(state: Partial<State>) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...readState(), ...state }, null, 2));
}
function calls(): { tool: string; args: string[] }[] {
  const text = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "";
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function secretValues(): string[] {
  const text = existsSync(join(dir, "secrets.log")) ? readFileSync(join(dir, "secrets.log"), "utf8") : "";
  return text.split("\n").filter(Boolean);
}
const appUrl = () => `https://127.0.0.1:${port}`;

function run(script: string, args: string[], input = ""): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, "repo", "scripts", script), ...args], {
      cwd: join(dir, "repo"),
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        FAKE_CLOUD_STATE: join(dir, "state.json"),
        FAKE_CLOUD_LOG: join(dir, "calls.log"),
        FAKE_CLOUD_SECRETS: join(dir, "secrets.log"),
        SELFHOST_WORKSPACE_TOOL: join(dir, "bin", "workspace"),
        SELFHOST_APPHOSTING_URL: `http://127.0.0.1:${port}`,
        SELFHOST_IDENTITY_TOOLKIT_URL: `http://127.0.0.1:${port}`,
        SELFHOST_FIREBASE_URL: `http://127.0.0.1:${port}`,
        SELFHOST_SECRETMANAGER_URL: `http://127.0.0.1:${port}`,
        SELFHOST_LOGGING_URL: `http://127.0.0.1:${port}`,
        SELFHOST_MONITORING_URL: `http://127.0.0.1:${port}`,
        SELFHOST_SERVICEUSAGE_URL: `http://127.0.0.1:${port}`,
        SELFHOST_HEALTH_WAIT_MS: "1",
        GOOGLE_APPLICATION_CREDENTIALS: join(dir, "adc.json"),
        FIRESTORE_EMULATOR_HOST: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input);
  });
}
const selfhost = (args: string[], input = "") => run("selfhost.mjs", ["--project", PROJECT, ...args], input);

const CORE_ANSWERS = [
  "--app-url", "", // filled per call
  "--admin-email", "owner@example.com",
  "--privacy-url", "https://example.com/privacy",
  "--workspace-name", "Acme",
  "--workspace-domain", "acme.test",
];
const coreAnswers = () => CORE_ANSWERS.map((a, i) => (i === 1 ? appUrl() : a));

const MUTATING = [
  ["gcloud", "services", "enable"],
  ["gcloud", "secrets", "create"],
  ["gcloud", "firestore", "databases", "create"],
  ["gcloud", "storage", "buckets", "create"],
  ["gcloud", "kms", "keys", "create"],
  ["gcloud", "scheduler", "jobs", "create"],
  ["firebase", "projects:addfirebase"],
  ["firebase", "apps:create"],
  ["firebase", "apphosting:backends:create"],
];
const mutatingCalls = (list: { tool: string; args: string[] }[]) =>
  list.filter((c) => MUTATING.some(([tool, ...words]) => c.tool === tool && words.every((w, i) => c.args[i] === w)));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "selfhost-test-"));
  const repo = join(dir, "repo");
  for (const path of ["scripts/selfhost.mjs", "scripts/doctor.mjs", "scripts/selfhost", "scripts/lib", "apphosting.yaml", "firestore.rules", "firestore.indexes.json", "infra/lifecycle", "infra/email-worker", "infra/distribute-worker"]) {
    cpSync(join(REPO, path), join(repo, path), { recursive: true });
  }
  mkdirSync(join(dir, "bin"));
  const fake = join(REPO, "scripts", "selfhost", "testing", "fake-cloud.mjs");
  for (const tool of ["gcloud", "firebase", "workspace"]) {
    writeFileSync(join(dir, "bin", tool), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${tool} "$@"\n`);
    chmodSync(join(dir, "bin", tool), 0o755);
  }
  writeFileSync(join(dir, "adc.json"), "{}");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ project: PROJECT, exists: true, account: "owner@example.com", billing: true, webApiKey: WEB_API_KEY }));

  // The REST endpoints selfhost reads with gcloud's token: App Hosting (environment name),
  // Identity Toolkit (Google sign-in, authorised domains, the password settings), and Logging
  // and Monitoring (the sign-in alerts).
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const state = readState() as FakeCloudState;
      const url = req.url ?? "";
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "PATCH" && url.includes("/backends/")) {
        const id = url.split("/backends/")[1]?.split("?")[0];
        state.backends = (state.backends ?? []).map((b) => (b.id === id ? { ...b, environment: JSON.parse(body).environment } : b));
        writeState(state);
        return send(200, { name: "operations/fake" });
      }
      // Secret Manager: who may read a secret, as apphosting:secrets:grantaccess leaves it.
      const policy = new RegExp(`^/v1/projects/${PROJECT}/secrets/([^/:]+):getIamPolicy$`).exec(url);
      if (req.method === "GET" && policy) {
        const name = decodeURIComponent(policy[1]!);
        if (!(state.secrets ?? []).includes(name)) return send(404, { error: { message: `Secret [${name}] not found` } });
        const members = (state.granted ?? []).includes(name) ? [`serviceAccount:firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com`] : [];
        return send(200, members.length ? { bindings: [{ role: "roles/secretmanager.secretAccessor", members }] } : {});
      }
      if (req.method === "GET" && url === `/v1beta1/projects/${PROJECT}`) return state.firebase ? send(200, { projectId: PROJECT }) : send(404, { error: { message: "not found" } });
      if (url.endsWith("/defaultSupportedIdpConfigs/google.com")) return state.googleSignIn ? send(200, { enabled: true }) : send(404, { error: { message: "CONFIGURATION_NOT_FOUND" } });
      if (req.method === "GET" && url.endsWith("/config")) {
        return send(200, { ...(state.identityConfig ?? {}), authorizedDomains: state.authorizedDomains ?? ["localhost", `${PROJECT}.firebaseapp.com`] });
      }
      if (req.method === "PATCH" && url.includes("/config?")) {
        // Applies each updateMask path from the body, as the admin v2 API does.
        const mask = new URL(url, "http://x").searchParams.get("updateMask") ?? "";
        state.patches = [...(state.patches ?? []), mask];
        if ((state.refuseMasks ?? []).some((m) => mask.split(",").some((p) => p.startsWith(m)))) {
          writeState(state);
          return send(400, { error: { message: `INVALID_CONFIG: ${mask} can't be changed on this project` } });
        }
        const sent = JSON.parse(body);
        for (const path of mask.split(",").filter(Boolean)) {
          if (path === "authorizedDomains") state.authorizedDomains = sent.authorizedDomains;
          else state.identityConfig = setPath(state.identityConfig ?? {}, path, getPath(sent, path));
        }
        writeState(state);
        return send(200, {});
      }
      // Service Usage: a service's own service agent, made on request (the fake project's number).
      const identity = /^\/v1beta1\/projects\/123456789012\/services\/([^/:]+):generateServiceIdentity$/.exec(url);
      if (req.method === "POST" && identity) {
        state.serviceIdentities = [...new Set([...(state.serviceIdentities ?? []), identity[1]!])];
        writeState(state);
        const email = `service-123456789012@gcp-sa-${identity[1]!.split(".")[0]}.iam.gserviceaccount.com`;
        return send(200, { name: "operations/fake", done: true, response: { email, uniqueId: "1" } });
      }
      // Cloud Logging: log based metrics.
      const metricsAt = `/v2/projects/${PROJECT}/metrics`;
      if (url.startsWith(metricsAt)) {
        const metrics = state.logMetrics ?? {};
        const name = url.slice(metricsAt.length + 1).split("?")[0] ?? "";
        if (req.method === "GET" && name) return metrics[name] ? send(200, metrics[name]) : send(404, { error: { message: `Metric ${name} does not exist.` } });
        if ((req.method === "POST" && !name) || (req.method === "PUT" && name)) {
          const m = JSON.parse(body);
          state.logMetrics = { ...metrics, [m.name]: m };
          writeState(state);
          return send(200, m);
        }
      }
      // Cloud Monitoring: alert policies and notification channels.
      for (const [field, kind] of [
        ["alertPolicies", "alertPolicies"],
        ["notificationChannels", "notificationChannels"],
      ] as const) {
        const at = `/v3/projects/${PROJECT}/${kind}`;
        if (!url.startsWith(at)) continue;
        if (state.monitoringOff) return send(403, { error: { message: "Cloud Monitoring API has not been used in project before or it is disabled." } });
        const list = (state[field] ?? []) as Record<string, unknown>[];
        if (req.method === "GET") return send(200, { [field]: list });
        if (req.method === "POST") {
          const item = { ...JSON.parse(body), name: `projects/${PROJECT}/${kind}/${list.length + 1}` };
          state[field] = [...list, item] as never;
          writeState(state);
          return send(200, item);
        }
      }
      send(404, { error: { message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("npm run selfhost: the plan", { timeout: SLOW }, () => {
  it("on a project that doesn't exist, says so, gives the next command, and changes nothing", async () => {
    writeState({ exists: false });
    const r = await selfhost([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Project ${PROJECT} wasn't found`);
    expect(r.out).toContain("Read-only checks: nothing was changed.");
    expect(r.out).toMatch(/2 {2}apis {7}can't tell/);
    expect(r.out).toContain(`Next: check the project id, or create it: gcloud projects create ${PROJECT}`);
    expect(mutatingCalls(calls())).toEqual([]);
  });

  it("on an empty project, lists every core step with its state and the next command", async () => {
    const r = await selfhost(["--json", "--app-url", appUrl()]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out);
    const states = Object.fromEntries(plan.steps.map((s: { id: string; state: string }) => [s.id, s.state]));
    expect(states).toEqual({
      account: "done",
      apis: "todo",
      firebase: "todo",
      firestore: "todo",
      storage: "todo",
      secrets: "todo",
      workspace: "todo",
      backend: "todo",
      connect: "todo",
      envfile: "todo",
      signin: "todo",
      scheduler: "todo",
      rollout: "todo",
    });
    expect(plan.next).toBe(`npm run selfhost -- --project ${PROJECT} --apply apis`);
    expect(plan.addons.map((a: { id: string }) => a.id)).toContain("addon:vizzy");
    expect(mutatingCalls(calls())).toEqual([]);
  });

  it("refuses an emulator-only project id and a bad option", async () => {
    const demo = await run("selfhost.mjs", ["--project", "demo-yougrow"]);
    expect(demo.code).toBe(2);
    expect(demo.out).toContain("emulator-only project id");
    const bad = await selfhost(["--apply", "everything"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('--apply "everything" is not a step');
  });
});

describe("npm run selfhost --apply", { timeout: SLOW }, () => {
  it("asks before a change: no stops it, yes goes ahead", async () => {
    const no = await selfhost(["--apply", "apis"], "n\n");
    expect(no.code).toBe(1);
    expect(no.out).toContain("It will:");
    expect(no.out).toContain("Go ahead? [y/N]");
    expect(no.out).toContain("Stopped. Nothing else was changed.");
    expect(mutatingCalls(calls())).toEqual([]);

    const yes = await selfhost(["--apply", "apis"], "y\n");
    expect(yes.code).toBe(0);
    expect(new Set(readState().apis as string[])).toEqual(new Set(REQUIRED_APIS.map((a) => a.id)));
  });

  it("with --yes, asks nothing and stops on a missing answer instead", async () => {
    writeState({ firebase: true, webApps: [{ appId: "1:1:web:x", displayName: "YouGrow" }], databases: { "(default)": "nam5" } });
    const r = await selfhost(["--apply", "workspace", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("pass --workspace-name (with --yes nothing is asked)");
    expect(r.out).not.toContain("Go ahead?");
    expect(r.out).toContain("only with the user's go-ahead");
  });

  it("passes the workspace step when its organisation fails, printing the repair", async () => {
    writeState({ firebase: true, webApps: [{ appId: "1:1:web:x", displayName: "YouGrow" }], databases: { "(default)": "nam5" }, workspaceOrganisationFails: true });
    const r = await selfhost(["--apply", "workspace", "--yes", "--workspace-name", "Acme", "--workspace-domain", "acme.test"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok   workspace ten_acme");
    expect(r.out).toContain("The workspace was created without an organisation.");
    expect(r.out).toContain(`GOOGLE_CLOUD_PROJECT=${PROJECT} npx tsx scripts/backfill-organisations.ts --tenant ten_acme --plan self_hosted`);
    expect(r.out).toContain("--apply --by <label>");
    expect(readState().tenants).toEqual([{ id: "ten_acme", name: "Acme", region: "us" }]);
  });

  it("--apply core --yes takes an empty project through every step, and a second run changes nothing", async () => {
    writeState({ googleSignIn: true });
    const first = await selfhost(["--apply", "core", "--yes", ...coreAnswers()]);
    // Everything but the last check: the fake backend never answers /api/health.
    expect(first.code).toBe(1);
    expect(first.out).toContain("Step 13 of 13 (rollout)");
    expect(first.out).toContain("/api/health doesn't answer yet");

    const s = readState() as State & {
      apis: string[];
      firebase: boolean;
      webApps: unknown[];
      databases: Record<string, string>;
      indexesDeployed: boolean;
      buckets: string[];
      secrets: string[];
      tenants: unknown[];
      backends: unknown[];
      granted: string[];
      kmsKey: boolean;
      authorizedDomains: string[];
      jobs: { name: string; uri: string }[];
      lastDeployConfig: { apphosting: { backendId: string }[] };
      deployConfigs: { firestore?: { database: string }[] }[];
    };
    expect(new Set(s.apis)).toEqual(new Set(REQUIRED_APIS.map((a) => a.id)));
    expect(s.firebase).toBe(true);
    expect(s.webApps).toHaveLength(1);
    expect(s.databases).toEqual({ "(default)": "nam5" });
    expect(s.indexesDeployed).toBe(true);
    expect(s.buckets).toEqual([`gs://${PROJECT}-yougrow-assets`]);
    expect(new Set(s.secrets)).toEqual(new Set([...CORE_SECRETS.map((x) => x.name), "firebase-web-api-key"]));
    expect(s.tenants).toEqual([{ id: "ten_acme", name: "Acme", region: "us" }]);
    expect(s.backends).toEqual([{ id: PROJECT, region: "us-central1", environment: "live" }]);
    expect(new Set(s.granted)).toEqual(new Set(s.secrets));
    expect(s.kmsKey).toBe(true);
    expect(s.authorizedDomains).toContain(`127.0.0.1:${port}`);
    expect(s.jobs.map((j) => j.name).sort()).toEqual(["distribute-scheduled-worker", "email-delivery-worker", "lifecycle-tick"]);
    for (const j of s.jobs) expect(j.uri.startsWith(`${appUrl()}/api/admin/`)).toBe(true);
    // The last deploy was the local-source rollout; Firestore went to (default) only.
    expect(s.lastDeployConfig.apphosting[0]?.backendId).toBe(PROJECT);
    expect(existsSync(join(dir, "repo", "firebase.selfhost.json"))).toBe(false);
    const firestoreDeploy = s.deployConfigs.find((c) => c.firestore);
    expect(firestoreDeploy?.firestore?.map((d) => d.database)).toEqual(["(default)"]);

    const before = calls().length;
    const second = await selfhost(["--apply", "core", "--yes", ...coreAnswers()]);
    expect(second.out).toContain("Step 2 of 13 (apis): done already.");
    expect(second.out).toContain("Step 12 of 13 (scheduler): done already.");
    expect(mutatingCalls(calls().slice(before))).toEqual([]);

    // No secret value, web key or worker secret is ever printed.
    const printed = `${first.out}\n${second.out}`;
    const values = [...secretValues(), WEB_API_KEY, "fake-secret-value-of"];
    expect(values.length).toBeGreaterThan(CORE_SECRETS.length);
    for (const v of values) expect(printed).not.toContain(v);
  });

  it("on a copy set up before a core secret was added, makes it and gives the backend access to it", async () => {
    const before = CORE_SECRETS.map((x) => x.name).filter((n) => n !== "connectors-vault-key");
    writeState({
      apis: REQUIRED_APIS.map((a) => a.id),
      firebase: true,
      webApps: [{ appId: "1:1:web:x", displayName: "YouGrow" }],
      databases: { "(default)": "nam5" },
      secrets: [...before, "firebase-web-api-key"],
      granted: [...before, "firebase-web-api-key"],
      backends: [{ id: PROJECT, region: "us-central1", environment: "live" }],
    });
    const stateOf = async (id: string) =>
      (JSON.parse((await selfhost(["--json", "--app-url", appUrl()])).out).steps as { id: string; state: string; detail: string }[]).find((s) => s.id === id)!;
    expect(await stateOf("secrets")).toMatchObject({ state: "todo", detail: expect.stringContaining("connectors-vault-key") });
    expect((await stateOf("backend")).state).toBe("done");

    expect((await selfhost(["--apply", "secrets", "--yes"])).code).toBe(0);
    // The secret exists now, but the backend can't read it: a rollout would fail.
    const backend = await stateOf("backend");
    expect(backend).toMatchObject({ state: "todo", detail: expect.stringContaining("can't read 1 of the app's secrets yet: connectors-vault-key") });

    const r = await selfhost(["--apply", "backend", "--yes", "--app-url", appUrl()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("including 1 added since it was set up: connectors-vault-key");
    expect(readState().granted).toContain("connectors-vault-key");
    expect((await stateOf("backend")).state).toBe("done");
    for (const v of secretValues()) expect(r.out).not.toContain(v);
  });

  it("stops at Google sign-in with the console steps when it isn't turned on", async () => {
    writeState({ backends: [{ id: PROJECT, region: "us-central1", environment: "live" }] });
    const r = await selfhost(["--apply", "signin", "--app-url", appUrl()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`https://console.firebase.google.com/project/${PROJECT}/authentication/providers`);
    expect(r.out).toContain(`Add domain: 127.0.0.1:${port}`);
    expect(r.out).toContain(`When that's done, run: npm run selfhost -- --project ${PROJECT} --apply signin`);
  });
});

describe("the env file npm run selfhost writes", { timeout: SLOW }, () => {
  async function setUpToEnvFile() {
    writeState({
      apis: REQUIRED_APIS.map((a) => a.id),
      firebase: true,
      webApps: [{ appId: "1:1:web:x", displayName: "YouGrow" }],
      databases: { "(default)": "nam5" },
      tenants: [{ id: "ten_acme", name: "Acme", region: "us" }],
      backends: [{ id: PROJECT, region: "us-central1", environment: "live" }],
    });
    return selfhost(["--apply", "envfile", "--yes", ...coreAnswers()]);
  }

  it("holds the project, the admin, the workspace, the address, secrets by name and the switches", async () => {
    const r = await setUpToEnvFile();
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, "repo", "apphosting.live.yaml"), "utf8");
    const env = entryMap(text);
    expect(env.get("GOOGLE_CLOUD_PROJECT")?.value).toBe(PROJECT);
    expect(env.get("NEXT_PUBLIC_FIREBASE_PROJECT_ID")?.availability).toEqual(["BUILD", "RUNTIME"]);
    expect(env.get("ADMIN_ALLOWED_EMAILS")?.value).toBe("owner@example.com");
    expect(env.get("ADMIN_BOOTSTRAP_TENANT_ID")?.value).toBe("ten_acme");
    expect(env.get("EMAIL_DEFAULT_PRIVACY_URL")?.value).toBe("https://example.com/privacy");
    expect(env.get("CONNECT_ISSUER")?.value).toBe(appUrl());
    expect(env.get("NEXT_PUBLIC_FIREBASE_API_KEY")?.secret).toBe("firebase-web-api-key");
    for (const s of CORE_SECRETS) expect(env.get(s.env)?.secret).toBe(s.name);
    expect(env.has("LIFECYCLE_MODE_CEILING")).toBe(false); // unset: product journeys stay in test mode

    const switches = baseSwitches(readFileSync(join(REPO, "apphosting.yaml"), "utf8"));
    const on = switches.filter((s) => !(s.name in KEPT_OFF));
    for (const s of on) {
      expect(env.get(s.name)?.value, s.name).toBe("true");
      expect(env.get(s.name)?.availability, s.name).toEqual(s.availability);
    }
    for (const name of Object.keys(KEPT_OFF)) expect(env.has(name), name).toBe(false);
    expect(text).toContain("SITE_HOME_ENABLED: YouGrow's own marketing homepage");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps the owner's edits on a re-run and only adds what is missing", async () => {
    await setUpToEnvFile();
    const file = join(dir, "repo", "apphosting.live.yaml");
    const edited = readFileSync(file, "utf8")
      .replace('value: "owner@example.com"', 'value: "someone@example.com"')
      .replace(/ {2}- variable: BRAND_VOICE_ENABLED\n {4}value: "true"\n {4}availability:\n {6}- RUNTIME\n/, "");
    writeFileSync(file, edited);
    expect(entryMap(edited).has("BRAND_VOICE_ENABLED")).toBe(false);

    const plan = JSON.parse((await selfhost(["--json", "--app-url", appUrl()])).out);
    expect(plan.steps.find((s: { id: string }) => s.id === "envfile").state).toBe("todo");

    const r = await selfhost(["--apply", "envfile", "--yes", "--app-url", appUrl()]);
    expect(r.code).toBe(0);
    const env = entryMap(readFileSync(file, "utf8"));
    expect(env.get("ADMIN_ALLOWED_EMAILS")?.value).toBe("someone@example.com");
    expect(env.get("BRAND_VOICE_ENABLED")?.value).toBe("true");
  });
});

/** A copy with every core step done up to its settings file, ready for an add-on. */
async function readyForAddons() {
  writeState({
    apis: REQUIRED_APIS.map((a) => a.id),
    firebase: true,
    webApps: [{ appId: "1:1:web:x", displayName: "YouGrow" }],
    databases: { "(default)": "nam5" },
    tenants: [{ id: "ten_acme", name: "Acme", region: "us" }],
    backends: [{ id: PROJECT, region: "us-central1", environment: "live" }],
  });
  const r = await selfhost(["--apply", "envfile", "--yes", ...coreAnswers()]);
  expect(r.code).toBe(0);
}

/** Give the copy an email provider, as addon:email would: password sign-in needs one for its codes. */
function withEmailProvider() {
  const file = join(dir, "repo", "apphosting.live.yaml");
  writeFileSync(file, `${readFileSync(file, "utf8").replace(/\n?$/, "\n")}  - variable: MANDRILL_API_KEY\n    secret: mandrill-api-key\n    availability:\n      - RUNTIME\n`);
}

/** Identity Toolkit's config as addon:password leaves it, less the reset link. */
const READY_CONFIG = {
  signIn: { email: { enabled: true, passwordRequired: true }, allowDuplicateEmails: false },
  emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
  passwordPolicyConfig: { passwordPolicyEnforcementState: "ENFORCE", passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 } }], forceUpgradeOnSignin: false },
  recaptchaConfig: { emailPasswordEnforcementState: "AUDIT" },
  monitoring: { requestLogging: { enabled: true } },
};

const ACCOUNT_RULES = "signIn.email.passwordRequired,emailPrivacyConfig.enableImprovedEmailPrivacy";

describe("npm run selfhost: addon:password", { timeout: SLOW }, () => {
  const password = (extra: string[] = []) => selfhost(["--apply", "addon:password", "--yes", "--app-url", appUrl(), ...extra]);
  const envFile = () => entryMap(readFileSync(join(dir, "repo", "apphosting.live.yaml"), "utf8"));

  it("in the plan, says what differs on a copy with Google sign-in only, and changes nothing", async () => {
    await readyForAddons();
    const before = calls().length;
    const plan = JSON.parse((await selfhost(["--json", "--app-url", appUrl()])).out);
    const addon = plan.addons.find((a: { id: string }) => a.id === "addon:password");
    expect(addon).toMatchObject({ title: "Turn on email and password sign-in", state: "todo" });
    for (const part of [
      "the Email/Password provider is off",
      "email enumeration protection is off",
      "the password policy isn't enforced",
      "reCAPTCHA bot protection for passwords is off",
      "no log metric yougrow_auth_signups",
      'no alert "YouGrow: accounts removed at sign-in"',
      "PASSWORD_SIGNIN_ENABLED is off",
      "no email provider yet (addon:email)",
      `password reset links open Firebase's own page, not ${appUrl()}/auth/reset`,
    ]) {
      expect(addon.detail).toContain(part);
    }
    expect((readState() as FakeCloudState).patches ?? []).toEqual([]);
    expect(mutatingCalls(calls().slice(before))).toEqual([]);
  });

  it("the command the troubleshooting row names really says the switch and the email provider are missing", async () => {
    await readyForAddons();
    const row = readFileSync(new URL("../../docs/self-host.md", import.meta.url), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| The sign-in page has no email and password fields |"));
    const named = /`npm run selfhost -- --project <id>([^`]*)`/.exec(row ?? "");
    expect(named, "the row names an npm run selfhost command").not.toBeNull();
    const args = named![1]!.trim().split(/\s+/).filter(Boolean);
    const r = await selfhost([...args, "--app-url", appUrl()]);
    expect(r.out).toContain("PASSWORD_SIGNIN_ENABLED is off");
    expect(r.out).toContain("no email provider yet (addon:email)");
  });

  it("leaves the switch off without an email provider, though Identity Platform and the alerts are set", async () => {
    await readyForAddons();
    const r = await password();
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok   read back: Email/Password on, 12 characters or more");
    expect(r.out).toContain("PASSWORD_SIGNIN_ENABLED stays off: password sign-in");
    expect(r.out).toContain(`--apply addon:email`);
    expect(envFile().has("PASSWORD_SIGNIN_ENABLED")).toBe(false);
    expect(r.out).not.toContain("Done: Email/Password on");
    expect(r.out).not.toMatch(/[–—]/);
  });

  it("sets every protection first, the provider last and alone, reads it back, makes the alerts and turns the switch on", async () => {
    await readyForAddons();
    withEmailProvider();
    const r = await password();
    expect(r.code).toBe(0);
    expect(r.out).toContain("It will:");
    expect(r.out).toContain("The Email/Password provider goes on last, after every protection above");
    const s = readState() as FakeCloudState & { apis: string[] };
    expect(s.patches).toEqual([
      ACCOUNT_RULES,
      "passwordPolicyConfig",
      "recaptchaConfig.emailPasswordEnforcementState",
      "monitoring.requestLogging.enabled",
      "notification.sendEmail.callbackUri",
      "signIn.email.enabled",
    ]);
    expect(s.identityConfig).toEqual({ ...READY_CONFIG, signIn: { email: { enabled: true, passwordRequired: true } }, notification: { sendEmail: { callbackUri: `${appUrl()}/auth/reset` } } });
    expect(r.out).toContain("ok   read back: Email/Password on, 12 characters or more");
    for (const api of ["recaptchaenterprise.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com"]) expect(s.apis).toContain(api);

    // Two log metrics and two alerts, each naming its resource type, emailing the first admin.
    expect(Object.keys(s.logMetrics ?? {}).sort()).toEqual(["yougrow_auth_accounts_removed", "yougrow_auth_signups"]);
    expect(s.logMetrics?.yougrow_auth_signups?.filter).toContain('resource.type="identitytoolkit_project"');
    expect(s.logMetrics?.yougrow_auth_accounts_removed?.filter).toBe('resource.type="cloud_run_revision" AND jsonPayload.event="auth_account_removed"');
    expect(s.notificationChannels).toEqual([expect.objectContaining({ type: "email", labels: { email_address: "owner@example.com" } })]);
    const channel = (s.notificationChannels?.[0] as { name: string }).name;
    const policies = s.alertPolicies as { displayName: string; notificationChannels: string[]; conditions: { conditionThreshold: { filter: string; duration: string; evaluationMissingData: string } }[] }[];
    expect(policies.map((p) => p.displayName)).toEqual(["YouGrow: many password sign-ups", "YouGrow: accounts removed at sign-in"]);
    for (const p of policies) {
      expect(p.notificationChannels).toEqual([channel]);
      const t = p.conditions[0]!.conditionThreshold;
      expect(t.filter).toMatch(/^metric\.type="logging\.googleapis\.com\/user\/yougrow_auth_\w+" AND resource\.type="\w+"$/);
      expect(t.evaluationMissingData).toBe("EVALUATION_MISSING_DATA_INACTIVE");
      expect(t.duration).not.toBe("0s");
    }

    expect(envFile().get("PASSWORD_SIGNIN_ENABLED")?.value).toBe("true");
    expect(envFile().has("PASSWORD_CLEANUP_DELETE_ENABLED")).toBe(false);
    expect(r.out).not.toContain("PASSWORD_SIGNIN_ENABLED stays off");
    expect(r.out).toContain("reCAPTCHA starts in audit mode");
    expect(r.out).toContain("Done: Email/Password on, 12 characters or more, reCAPTCHA in audit mode, alerts set");
    expect(r.out).not.toMatch(/[–—]/);

    // reCAPTCHA's keys need Identity Platform's service agent, with its role, before the config.
    const agent = "service-123456789012@gcp-sa-identitytoolkit.iam.gserviceaccount.com";
    expect(r.out).toContain("Make Identity Platform's service agent and give it roles/identitytoolkit.serviceAgent");
    expect(s.serviceIdentities).toEqual(["identitytoolkit.googleapis.com"]);
    // The codes' TTL clean-up, for copies set up before these collections existed.
    for (const group of ["email_codes", "email_code_guards"]) {
      expect(calls()).toContainEqual({
        tool: "gcloud",
        args: ["firestore", "fields", "ttls", "update", "ttl", `--collection-group=${group}`, "--enable-ttl", "--database=(default)", `--project=${PROJECT}`, "--async"],
      });
    }
    expect(calls()).toContainEqual({
      tool: "gcloud",
      args: ["projects", "add-iam-policy-binding", PROJECT, `--member=serviceAccount:${agent}`, "--role=roles/identitytoolkit.serviceAgent", "--condition=None"],
    });
    expect(r.out.indexOf(`ok   roles/identitytoolkit.serviceAgent for ${agent}`)).toBeLessThan(r.out.indexOf("reCAPTCHA bot protection (recaptchaConfig"));

    // A second run finds it done and sends nothing again.
    const again = await password();
    expect(again.code).toBe(0);
    expect(again.out).toContain("set up already");
    const after = readState() as FakeCloudState;
    expect(after.patches).toHaveLength(6);
    expect(after.alertPolicies).toHaveLength(2);
    expect(after.notificationChannels).toHaveLength(1);
    expect(again.out).toContain('alert "YouGrow: many password sign-ups" (already there, left as it is)');
  });

  it("makes no email channel on a later run when the alerts are there, even for a new first admin", async () => {
    await readyForAddons();
    expect((await password()).code).toBe(0);
    const yaml = join(dir, "repo", "apphosting.live.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace('value: "owner@example.com"', 'value: "new.owner@example.com"'));
    const again = await password();
    expect(again.code).toBe(0);
    expect(again.out).toContain("the alerts are already there and keep their recipients");
    expect(again.out).not.toContain("new.owner@example.com");
    const s = readState() as FakeCloudState;
    expect(s.notificationChannels).toHaveLength(1);
    expect(s.notificationChannels?.[0]).toMatchObject({ labels: { email_address: "owner@example.com" } });
  });

  it("changes only what differs, and keeps a stricter project's settings it doesn't own", async () => {
    await readyForAddons();
    withEmailProvider();
    writeState({
      identityConfig: {
        ...READY_CONFIG,
        signIn: { email: { enabled: true, passwordRequired: true }, allowDuplicateEmails: true },
        passwordPolicyConfig: {
          passwordPolicyEnforcementState: "ENFORCE",
          passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 8, maxPasswordLength: 64, containsUppercaseCharacter: true } }],
        },
        recaptchaConfig: { emailPasswordEnforcementState: "ENFORCE" },
        notification: { sendEmail: { callbackUri: `${appUrl()}/auth/reset` } },
      },
    });
    const r = await password();
    expect(r.code).toBe(0);
    const s = readState() as FakeCloudState;
    expect(s.patches).toEqual(["signIn.allowDuplicateEmails", "passwordPolicyConfig"]);
    expect(getPath(s.identityConfig, "passwordPolicyConfig.passwordPolicyVersions")).toEqual([{ customStrengthOptions: { minPasswordLength: 12, maxPasswordLength: 64 } }]);
    expect(getPath(s.identityConfig, "recaptchaConfig.emailPasswordEnforcementState")).toBe("ENFORCE");
    expect(r.out).toContain("reCAPTCHA enforced");
  });

  it("only warns when the project refuses the reset link's address, and still turns the provider on", async () => {
    await readyForAddons();
    writeState({ refuseMasks: ["notification"] });
    const r = await password();
    expect(r.code).toBe(0);
    expect(r.out).toContain("warn reset link address (notification.sendEmail.callbackUri)");
    expect(r.out).toContain("Warning: Identity Platform refused the reset link's address. Set it by hand");
    expect(r.out).toContain(`Customize action URL: ${appUrl()}/auth/reset`);
    const s = readState() as FakeCloudState;
    expect(s.patches?.at(-1)).toBe("signIn.email.enabled");
    expect(getPath(s.identityConfig, "signIn.email.enabled")).toBe(true);
    expect(r.out).toContain("Also: password reset links open Firebase's own page");
  });

  it("stops at a refused protection, before the provider, and leaves the switch off", async () => {
    await readyForAddons();
    writeState({ refuseMasks: ["passwordPolicyConfig"] });
    const r = await password();
    expect(r.code).toBe(1);
    expect(r.out).toContain("fail password policy (passwordPolicyConfig)");
    expect(r.out).toContain(
      "Nothing after it was sent (reCAPTCHA bot protection, request logging, reset link address, Email/Password provider), so the Email/Password provider stays as it was.",
    );
    const s = readState() as FakeCloudState;
    expect(s.patches).toEqual([ACCOUNT_RULES, "passwordPolicyConfig"]);
    expect(getPath(s.identityConfig, "signIn.email.enabled")).toBeUndefined();
    expect(s.alertPolicies ?? []).toEqual([]);
    expect(envFile().has("PASSWORD_SIGNIN_ENABLED")).toBe(false);
  });

  it("leaves the switch off when the alerts can't be made, and says to run it again", async () => {
    await readyForAddons();
    writeState({ monitoringOff: true });
    const r = await password();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Making the sign-in alerts failed (see above). Identity Platform is set; run this add-on again to finish the alerts.");
    expect(getPath((readState() as FakeCloudState).identityConfig, "signIn.email.enabled")).toBe(true);
    expect(envFile().has("PASSWORD_SIGNIN_ENABLED")).toBe(false);
  });

  it("needs the core steps first", async () => {
    writeState({ backends: [{ id: PROJECT, region: "us-central1", environment: "live" }] });
    const r = await password();
    expect(r.code).toBe(1);
    expect(r.out).toContain("No apphosting.live.yaml yet. Run the core steps first");
    expect((readState() as FakeCloudState).patches ?? []).toEqual([]);
  });
});

describe("npm run doctor -- --cloud", { timeout: SLOW }, () => {
  const writeEnv = (entries: string) => writeFileSync(join(dir, "repo", "apphosting.live.yaml"), `env:\n${entries}`);
  const SWITCH_ON = '  - variable: PASSWORD_SIGNIN_ENABLED\n    value: "true"\n    availability:\n      - RUNTIME\n';
  const MANDRILL = "  - variable: MANDRILL_API_KEY\n    secret: mandrill-api-key\n    availability:\n      - RUNTIME\n";

  it("with password sign-in on, fails without an email provider or a ready Identity Platform", async () => {
    writeState({ backends: [{ id: PROJECT, region: "us-central1", environment: "live" }] });
    writeEnv(SWITCH_ON);
    const r = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(r.out).toContain("fail  PASSWORD_SIGNIN_ENABLED is on, but no email provider is set");
    expect(r.out).toContain(`fix: npm run selfhost -- --project ${PROJECT} --apply addon:email`);
    expect(r.out).toMatch(/fail +Password sign-in is on, but Identity Platform isn't ready: .*the Email\/Password provider is off/);
    expect(r.out).toContain("warn  Password sign-in: reCAPTCHA bot protection for passwords is off.");
    expect(r.out).toContain(`fix: npm run selfhost -- --project ${PROJECT} --apply addon:password`);
    expect(r.code).toBe(1);
    expect(mutatingCalls(calls())).toEqual([]);
  });

  it("with password sign-in on and set up, passes; with it off, checks nothing about it", async () => {
    const host = `https://${PROJECT}--${PROJECT}.us-central1.hosted.app`;
    writeState({
      backends: [{ id: PROJECT, region: "us-central1", environment: "live" }],
      identityConfig: { ...READY_CONFIG, notification: { sendEmail: { callbackUri: `${host}/auth/reset` } } },
    });
    writeEnv(SWITCH_ON + MANDRILL);
    const on = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(on.out).toContain("ok    Identity Platform is set for password sign-in (12 characters or more, one account per address)");
    expect(on.out).not.toContain("email provider");
    expect(on.out).not.toContain("Password sign-in:");

    writeEnv(MANDRILL);
    const off = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(off.out).not.toContain("Identity Platform");
  });

  it("says what is missing, read-only, with a fix for each", async () => {
    writeState({ apis: ["firestore.googleapis.com"], secrets: ["lifecycle-worker-secret"] });
    const r = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(r.out).toContain("ok    gcloud signed in as owner@example.com");
    expect(r.out).toContain(`ok    Project ${PROJECT}`);
    expect(r.out).toContain("ok    Billing is on");
    expect(r.out).toMatch(/fail +\d+ required APIs are off/);
    expect(r.out).toContain(`fix: npm run selfhost -- --project ${PROJECT} --apply apis`);
    expect(r.out).toMatch(/fail +11 core secrets are missing/);
    expect(r.out).toContain("connectors-vault-key");
    expect(r.out).toContain(`No App Hosting backend "${PROJECT}"`);
    expect(r.out).toContain("No apphosting.live.yaml in this folder.");
    expect(r.code).toBe(1);
    expect(mutatingCalls(calls())).toEqual([]);
  });

  it("on a project that doesn't exist, stops at the project check", async () => {
    writeState({ exists: false });
    const r = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(r.out).toContain(`Project ${PROJECT} wasn't found`);
    expect(r.out).not.toContain("Billing");
    expect(r.code).toBe(1);
  });
});
