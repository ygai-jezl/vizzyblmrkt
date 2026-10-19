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

  // The REST endpoints selfhost reads with gcloud's token: App Hosting (environment name) and
  // Identity Toolkit (Google sign-in, authorised domains).
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const state = readState() as State & { backends?: { id: string; environment: string }[]; firebase?: boolean; googleSignIn?: boolean; authorizedDomains?: string[] };
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
      if (req.method === "GET" && url === `/v1beta1/projects/${PROJECT}`) return state.firebase ? send(200, { projectId: PROJECT }) : send(404, { error: { message: "not found" } });
      if (url.endsWith("/defaultSupportedIdpConfigs/google.com")) return state.googleSignIn ? send(200, { enabled: true }) : send(404, { error: { message: "CONFIGURATION_NOT_FOUND" } });
      if (req.method === "GET" && url.endsWith("/config")) return send(200, { authorizedDomains: state.authorizedDomains ?? ["localhost", `${PROJECT}.firebaseapp.com`] });
      if (req.method === "PATCH" && url.includes("/config?")) {
        state.authorizedDomains = JSON.parse(body).authorizedDomains;
        writeState(state);
        return send(200, {});
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

describe("npm run doctor -- --cloud", { timeout: SLOW }, () => {
  it("says what is missing, read-only, with a fix for each", async () => {
    writeState({ apis: ["firestore.googleapis.com"], secrets: ["lifecycle-worker-secret"] });
    const r = await run("doctor.mjs", ["--cloud", "--project", PROJECT]);
    expect(r.out).toContain("ok    gcloud signed in as owner@example.com");
    expect(r.out).toContain(`ok    Project ${PROJECT}`);
    expect(r.out).toContain("ok    Billing is on");
    expect(r.out).toMatch(/fail +\d+ required APIs are off/);
    expect(r.out).toContain(`fix: npm run selfhost -- --project ${PROJECT} --apply apis`);
    expect(r.out).toMatch(/fail +10 core secrets are missing/);
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
