#!/usr/bin/env node
/**
 * Register YouGrow's READ-ONLY GitHub App for one deployment, using GitHub's
 * app-manifest flow, and put its credentials straight into Secret Manager.
 *
 *   node infra/github-app/create-app.mjs --project <id> --origin <https url> [--name <app name>]
 *       [--backend <id>] [--owner <github-org>] [--homepage <url>] [--dry-run]
 *
 *   --project   your Google Cloud project id (where the secrets go)
 *   --origin    your app's https origin, e.g. https://app.example.com (the callback URL's host)
 *   --name      the app's name on GitHub (default "YouGrow"; GitHub names must be unique)
 *   --backend   your App Hosting backend id (default: the project id)
 *   --owner     create it under this GitHub organisation (default: your personal account)
 *   --homepage  the app's homepage link on GitHub (default: --origin)
 *   --dry-run   print the manifest and exit; nothing is created
 *
 * What happens:
 *  1. A one-off page on 127.0.0.1 opens GitHub's "create app" screen, pre-filled:
 *     Contents: read + Metadata: read ONLY, no webhook, your callback,
 *     "request user authorization during installation" on, installable by anyone.
 *  2. You review it (you can edit the name) and click Create.
 *  3. GitHub returns a one-time code to this script, which exchanges it for the
 *     app's credentials and writes the PRIVATE KEY and CLIENT SECRET directly to
 *     Secret Manager (github-app-private-key, github-app-client-secret), then
 *     grants the App Hosting backend and the knowledge-scraper Job access.
 *
 * Nothing secret is printed, logged or written to disk. Only the public values
 * (App ID, slug, Client ID) are printed: those go into apphosting.<env>.yaml.
 *
 * Needs: gcloud and firebase CLIs signed in (gcloud auth login; firebase login --reauth).
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_NAME = "YouGrow";
const SECRET_KEY = "github-app-private-key";
const SECRET_CLIENT = "github-app-client-secret";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const USAGE =
  "Usage: node infra/github-app/create-app.mjs --project <id> --origin <https url> [--name <app name>] [--backend <id>] [--owner <github-org>] [--homepage <url>] [--dry-run]";

/** An https origin with no path (e.g. https://app.example.com), or null. */
export function httpsOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const project = arg("project");
const origin = httpsOrigin(arg("origin"));
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !origin) {
  console.error(USAGE);
  if (project && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) console.error(`--project: "${project}" is not a Google Cloud project id.`);
  if (arg("origin") && !origin) console.error("--origin must be an https origin with no path, e.g. https://app.example.com");
  process.exit(2);
}
const backend = arg("backend") ?? project;
if (!/^[a-z][a-z0-9-]{0,29}$/.test(backend)) {
  console.error("--backend must be an App Hosting backend id (lowercase letters, digits and hyphens).");
  process.exit(2);
}
const homepage = arg("homepage") ?? origin;
if (!/^https:\/\/\S+$/.test(homepage)) {
  console.error("--homepage must be an https URL.");
  process.exit(2);
}
const owner = arg("owner");
if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) {
  console.error("--owner must be a GitHub organisation login.");
  process.exit(2);
}
const appName = arg("name") ?? DEFAULT_NAME;
const dryRun = process.argv.includes("--dry-run");

function run(cmd, args, input) {
  // stdout is discarded: nothing a command prints can leak a secret into this terminal.
  const r = spawnSync(cmd, args, { input, stdio: ["pipe", "ignore", "pipe"], encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr ?? "").trim().split("\n").slice(-2).join(" ") };
}

export function buildManifest({ name, origin, homepage, redirectUrl }) {
  return {
    name,
    url: homepage,
    description: "Read-only access so YouGrow can learn how your product works. YouGrow never changes your code.",
    public: true,
    redirect_url: redirectUrl,
    callback_urls: [`${origin}/api/admin/integrations/github/callback`],
    request_oauth_on_install: true,
    setup_on_update: true,
    hook_attributes: { url: `${origin}/api/github/unused-webhook`, active: false },
    default_permissions: { contents: "read", metadata: "read" },
    default_events: [],
  };
}

if (dryRun) {
  console.log(JSON.stringify(buildManifest({ name: appName, origin, homepage, redirectUrl: "http://127.0.0.1:PORT/done" }), null, 2));
  process.exit(0);
}

// Pre-flight: both CLIs must be signed in before GitHub hands us credentials.
if (!run("gcloud", ["auth", "print-access-token"]).ok) {
  console.error("gcloud isn't signed in. Run: gcloud auth login");
  process.exit(1);
}
if (!run("gcloud", ["projects", "describe", project]).ok) {
  console.error(`Can't reach ${project} with gcloud. Check the project id and your account.`);
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
let finished = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const port = server.address().port;
  const page = (title, body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto">${body}</body>`);
  };

  if (url.pathname === "/") {
    const manifest = buildManifest({ name: appName, origin, homepage, redirectUrl: `http://127.0.0.1:${port}/done` });
    const action = owner
      ? `https://github.com/organizations/${owner}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`;
    const escaped = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return page(
      "Create the YouGrow GitHub App",
      `<p>Opening GitHub to create <b>${appName}</b> for ${origin}: read-only, Contents + Metadata.</p>
       <form id="f" method="post" action="${action}"><input type="hidden" name="manifest" value="${escaped}"><button>Continue to GitHub</button></form>
       <script>document.getElementById("f").submit()</script>`,
    );
  }

  if (url.pathname === "/done") {
    if (finished) return page("Already done", "<p>This app was already created. You can close this tab.</p>");
    if (url.searchParams.get("state") !== state) return page("Refused", "<p>That request didn't come from this setup run.</p>");
    const code = url.searchParams.get("code");
    if (!code || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) return page("Missing code", "<p>GitHub didn't return a code.</p>");
    finished = true;
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "YouGrow-Setup" },
      });
      const app = await r.json();
      if (!r.ok || !app.pem || !app.client_secret) throw new Error(`GitHub conversion failed (${r.status}).`);

      // Secrets go straight to Secret Manager via stdin, never printed or written to disk.
      for (const [name, value] of [[SECRET_KEY, app.pem], [SECRET_CLIENT, app.client_secret]]) {
        if (!run("gcloud", ["secrets", "describe", name, `--project=${project}`]).ok) {
          const c = run("gcloud", ["secrets", "create", name, "--replication-policy=automatic", `--project=${project}`]);
          if (!c.ok) throw new Error(`Couldn't create ${name}: ${c.err}`);
        }
        const a = run("gcloud", ["secrets", "versions", "add", name, "--data-file=-", `--project=${project}`], value);
        if (!a.ok) throw new Error(`Couldn't store ${name}: ${a.err}`);
      }
      delete app.pem;
      delete app.client_secret;
      delete app.webhook_secret;

      const notes = [];
      for (const name of [SECRET_KEY, SECRET_CLIENT]) {
        const g = run("firebase", ["apphosting:secrets:grantaccess", name, "--backend", backend, "--project", project, "--non-interactive"]);
        if (!g.ok) notes.push(`firebase apphosting:secrets:grantaccess ${name} --backend ${backend} --project ${project}`);
      }
      const job = run("gcloud", [
        "secrets", "add-iam-policy-binding", SECRET_KEY, `--project=${project}`,
        `--member=serviceAccount:knowledge-scraper@${project}.iam.gserviceaccount.com`,
        "--role=roles/secretmanager.secretAccessor",
      ]);
      if (!job.ok) notes.push(`gcloud secrets add-iam-policy-binding ${SECRET_KEY} --project=${project} --member=serviceAccount:knowledge-scraper@${project}.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor`);

      page("Done", `<p><b>${app.name}</b> created and its credentials stored in Secret Manager. You can close this tab.</p>`);
      console.log(`\n✔ Created GitHub App "${app.name}" for ${origin}: ${app.html_url}`);
      console.log("✔ Private key and client secret stored in Secret Manager (not shown).");
      console.log("\nPublic values for apphosting.<env>.yaml (or paste them to your coding agent):");
      console.log(`  GITHUB_APP_ID=${app.id}`);
      console.log(`  GITHUB_APP_SLUG=${app.slug}`);
      console.log(`  GITHUB_APP_CLIENT_ID=${app.client_id}`);
      if (notes.length) {
        console.log("\n! Some access grants didn't go through (usually: sign in again with `firebase login --reauth`). Run:");
        for (const n of notes) console.log(`  ${n}`);
      }
      setTimeout(() => process.exit(0), 200);
    } catch (err) {
      page("Failed", `<p>${String(err.message ?? err).replace(/</g, "&lt;")}</p>`);
      console.error(`\n✘ ${err.message ?? err}`);
      setTimeout(() => process.exit(1), 200);
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Creating the GitHub App "${appName}" for ${origin}${owner ? ` under ${owner}` : " under your personal account"}.`);
  console.log(`Opening ${url}. If no browser opens, visit it yourself.`);
  if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  setTimeout(() => {
    if (!finished) {
      console.error("Timed out after 15 minutes without GitHub returning. Nothing was stored.");
      process.exit(1);
    }
  }, 15 * 60_000).unref();
});
