# Host YouGrow on your own Google Cloud

This guide takes an empty Google Cloud project to your own running copy of YouGrow.
One command does the work, step by step, and shows you each change before it makes it.

**With a coding agent.** Open this repo in Claude Code or Cursor and say:

```
Host YouGrow on my Google Cloud project <your-project-id>. Follow docs/self-host.md.
```

The agent runs the read-only plan, asks you before each change, and hands you the
few steps that need a browser.

**Agents:** run the plan first. Before any `--apply`, show the user what the step changes
and get their yes; then add `--yes`. Never ask the user to paste a key or secret into
the chat: the add-ons that need keys ask for them in the user's own terminal.

## What you need

- **A Google Cloud project with billing on.** App Hosting needs the pay as you go (Blaze)
  plan. No project yet? `gcloud projects create <id>`, then
  [link a billing account](https://console.cloud.google.com/billing/linkedaccount).
- **The Google Cloud CLI**, signed in twice (your account, and the credentials scripts use):
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```
- **The Firebase CLI**, 14.4 or newer: `npm install -g firebase-tools`, then `firebase login`.
- **This repo** on your machine with Node 24 and `npm install` done. Fork it on GitHub
  first if you want every push to roll out by itself.
- **About 45 minutes.** Most of it is the first build.

## What it costs

You pay Google for what your copy uses. Left idle it costs little: the app scales to zero
(`minInstances: 0` in `apphosting.yaml`), so you mostly pay for builds, storage and the AI
calls people make. The parts that bill:

- **App Hosting** builds with Cloud Build, stores images in Artifact Registry and serves on
  Cloud Run.
- **Firestore**, **Cloud Storage** and **Secret Manager**: small amounts for a small copy.
- **Gemini on Vertex AI**: per use, when someone writes or makes images with AI.
- **Cloud KMS**: one HSM signing key, a small monthly charge.
- **Cloud Scheduler**: three jobs.

Set a budget alert before you start: [Budgets and alerts](https://console.cloud.google.com/billing/budgets).
An alert tells you; it doesn't stop spending
([Google: create a budget](https://cloud.google.com/billing/docs/how-to/budgets)). For a
hard stop, `infra/billing-killswitch` turns billing off past a cap; its header explains it
([Google: disable billing with notifications](https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications)).

## 1. See the plan

```bash
npm run selfhost -- --project <your-project-id>
```

This only reads. It lists every step below as **done**, **to do** or **can't tell**, and
prints the exact next command. Run it whenever you want to see where things stand.

Options: `--region` (default `us-central1`), `--env` (default `live`: your settings file is
`apphosting.<env>.yaml`), `--backend` (default: the project id).

## 2. Run the core steps

```bash
npm run selfhost -- --project <your-project-id> --apply core
```

It runs the steps in order and skips the ones already done. Before each, it shows the
project and what will change, and asks `Go ahead? [y/N]`. Run one step on its own with
`--apply <step>`. If a step stops, fix what it says and run the same command again.

| Step | What it does | Check it worked |
| --- | --- | --- |
| `account` | Checks gcloud is signed in, the project exists and billing is on. Only checks: the fixes are yours. | The plan shows it done |
| `apis` | Turns on the 17 APIs the app uses (App Hosting, Firestore, Vertex AI, Secret Manager, Cloud Scheduler and others). | `gcloud services list --enabled --project <id>` |
| `firebase` | Adds Firebase to the project and makes a web app called YouGrow. | `firebase apps:list WEB --project <id>` |
| `firestore` | Creates the default Firestore database and deploys `firestore.rules` and `firestore.indexes.json` to it. Asks the location (default `nam5`, the US). **The location is permanent** ([locations](https://firebase.google.com/docs/firestore/locations)). | `gcloud firestore databases describe --database='(default)' --project <id>` |
| `storage` | Creates a private bucket, `<id>-yougrow-assets`, for brand files and images. | `gcloud storage buckets describe gs://<id>-yougrow-assets` |
| `secrets` | Makes the app's ten keys and worker secrets with random values, plus the web app's public API key, in Secret Manager. Values are never shown. | `gcloud secrets list --project <id>` |
| `workspace` | Creates your first workspace (your brand) with the app's own code. Asks its name and website domain. | `npx tsx scripts/selfhost/create-workspace.ts --project <id> --list` |
| `backend` | Creates the App Hosting backend, lets it use Vertex AI, the bucket and the secrets, and sets its environment name to `live` so it reads `apphosting.live.yaml`. | `firebase apphosting:backends:list --project <id>` |
| `connect` | Creates the key that signs requests to connected products, and turns on clean-up of old event data. | `bash infra/lifecycle/setup.sh verify <id>` |
| `envfile` | Writes `apphosting.live.yaml`: your project, your Google email as the first admin, your workspace, your app's address, every secret by name and the feature switches on. Asks your email and your privacy policy's URL. | Open the file |
| `signin` | Turns on Google sign-in. Needs the Firebase console once (it prints the links); then it adds your app's domain to the authorised domains. | The plan shows it done |
| `scheduler` | Creates the three scheduled jobs that run journeys, emails and posts. | `gcloud scheduler jobs list --location us-central1 --project <id>` |
| `rollout` | Builds and rolls out the app, then checks `/api/health`. | Open your app's address |

Your app's address is `https://<backend>--<project>.us-central1.hosted.app`. Open it, click
**Sign in with Google** and use the email you gave: you land in your workspace.

### Two choices along the way

- **Rolling out from GitHub.** Without GitHub, the `rollout` step uploads this folder
  ([deploy from local source](https://firebase.google.com/docs/app-hosting/alt-deploy)).
  To roll out on every push instead, connect your fork in the Firebase console: App
  Hosting, your backend, connect a GitHub repository, live branch `main`
  ([get started](https://firebase.google.com/docs/app-hosting/get-started)). Then commit
  `apphosting.live.yaml` and push it; `rollout` starts a rollout from the branch.
- **Your settings file is in your fork.** If your fork is public, so is the file. It holds
  no secrets (those are names in Secret Manager), but it does hold your project id and
  admin email.

### Coding agents and `--yes`

`--yes` skips the questions. Pass the answers as options too, or the step stops:
`--location`, `--admin-email`, `--privacy-url`, `--workspace-name`, `--workspace-domain`
and, for a workspace outside the US, `--workspace-region eu|asia`.

## 3. Add what you need

Each add-on is optional. Run it after the core steps:

```bash
npm run selfhost -- --project <your-project-id> --apply addon:<name>
```

| Add-on | What you get | How |
| --- | --- | --- |
| `addon:email` | Real email through Mandrill or Resend, from your own address | Automated. Asks for the API key in your terminal |
| `addon:vizzy` | Vizzy, the chat agent, on Agent Runtime | Automated. Needs Python 3.10+ (it prints the two setup lines) |
| `addon:knowledge` | Reading websites and repos into a brand's knowledge | Automated |
| `addon:github-app` | A read-only GitHub App, so YouGrow can learn a product from its repo | Opens GitHub in your browser, where you click Create |
| `addon:linkedin`, `addon:x` | Posting to LinkedIn or X | You create the app on their developer site; then automated, asking for its keys in your terminal |
| `addon:regions` | EU and Asia databases, for workspaces whose data must stay there | Automated. Each database bills on its own |
| `addon:bigquery` | Analytics breakdowns from BigQuery | Automated. The extensions deploy may ask you to accept their permissions |
| `addon:recaptcha` | reCAPTCHA on waitlist sign-ups | Automated |

Each add-on writes its settings into `apphosting.live.yaml` and turns its switches on.
Roll out afterwards: `npm run selfhost -- --project <id> --apply rollout` (or push).

**Email: test mode first.** With a provider set, waitlist emails send. Product journeys
stay in test mode, sending nothing real, until you add `LIFECYCLE_MODE_CEILING` with the
value `"live"` to your settings file. Journeys also need `EMAIL_DEFAULT_PRIVACY_URL`, which
the `envfile` step asks for.

## Your settings file

`apphosting.live.yaml` sits beside `apphosting.yaml`. App Hosting merges it over
`apphosting.yaml` at build time when the backend's environment name is `live`
([multiple environments](https://firebase.google.com/docs/app-hosting/multiple-environments)).
`apphosting.yaml` lists every feature switch as `"false"`; your file turns them on.

- **To turn a feature on or off**, set its switch to `"true"` or `"false"` in your file and
  roll out.
- **Left off on purpose** (the top of your file lists them with why): YouGrow's own
  marketing site and Google Analytics, and the switches an add-on turns on.
- **Secrets** are referenced by name (`secret: email-worker-secret`). Add one with
  `firebase apphosting:secrets:set <name> --project <id>` and give the backend access with
  `firebase apphosting:secrets:grantaccess <name> --backend <backend> --project <id>`
  ([configure App Hosting](https://firebase.google.com/docs/app-hosting/configure)).
- **A custom domain:** add it to the backend
  ([custom domains](https://firebase.google.com/docs/app-hosting/custom-domain)), then set
  `NEXT_PUBLIC_PLATFORM_ORIGIN`, `EMAIL_LINK_ORIGIN` and `CONNECT_ISSUER` to it, add it to
  the authorised domains, re-point the scheduled jobs with `--app-url https://<domain>
  --apply scheduler`, and roll out.

Re-running `--apply envfile` only adds entries that are missing. It never changes one you set.

## Keep your fork up to date

```bash
git remote add upstream https://github.com/ygai-jezl/vizzyblmrkt   # once
git fetch upstream
git merge upstream/main
```

Merges don't clash with your settings: they live in `apphosting.live.yaml`, a file the
upstream repo never has. New features arrive as switches set to `"false"` in
`apphosting.yaml`, so nothing changes until you turn them on. After a merge, run the plan:
it shows anything new to set up (a new secret, say). Then push, or `--apply rollout`.

## When something goes wrong

Start with the read-only checks. Each problem comes with the command that fixes it:

```bash
npm run doctor -- --cloud --project <your-project-id>
```

| You see | Fix |
| --- | --- |
| The build fails with `Error resolving secret version` | The backend can't read a secret: `npm run selfhost -- --project <id> --apply backend` gives it access again |
| The sign-in popup says the domain isn't authorised | `--apply signin` adds your app's domain (or add it in the Firebase console, Authentication, Settings) |
| "Access denied. This account isn't on the admin list." | Your Google email must be in `ADMIN_ALLOWED_EMAILS` in your settings file; roll out after changing it |
| "This workspace isn't set up yet." | `ADMIN_BOOTSTRAP_TENANT_ID` must name a workspace that exists (`npx tsx scripts/selfhost/create-workspace.ts --project <id> --list`) |
| Emails go to the log, not to people | No provider yet (`addon:email`). Product journeys also need `LIFECYCLE_MODE_CEILING` set to `"live"` |
| Scheduled jobs fail with 401 | The job's secret doesn't match the app's: `--apply scheduler`, then roll out |
| The backend doesn't read your settings file | Its environment name must match the file: App Hosting, your backend, Settings, Environment |

The build log for each rollout is in the Firebase console: App Hosting, your backend,
Rollouts.

## Embed the waitlist on another site

Copy the snippet from the admin **Widget** tab (`/admin/widget`). It looks like:

```html
<div data-vizzybl-campaign="beta-launch" data-vizzybl-type="WIDGET_1"></div>
<script src="https://<your-app-origin>/embed.js" async></script>
```

`/embed.js` turns each `div` into a self-resizing frame of `/embed/<campaign>` on your app's
address, so sign-ups, reCAPTCHA and the brand's look all work inside it. Widget types:
`WIDGET_1` (full form), `WIDGET_2` (email only, inline), `WIDGET_3` (email only, button
inside the field). Only `/embed/*` may be framed by other sites; every other page refuses
to be framed (see `next.config.ts`).

## How the steps map to Google's docs

- App Hosting: [get started](https://firebase.google.com/docs/app-hosting/get-started),
  [multiple environments](https://firebase.google.com/docs/app-hosting/multiple-environments),
  [configure](https://firebase.google.com/docs/app-hosting/configure),
  [deploy from local source](https://firebase.google.com/docs/app-hosting/alt-deploy),
  [custom domains](https://firebase.google.com/docs/app-hosting/custom-domain)
- Secrets: [Secret Manager best practices](https://cloud.google.com/secret-manager/docs/best-practices)
  (least privilege per secret; values sent on stdin, never on the command line)
- Firestore: [locations](https://firebase.google.com/docs/firestore/locations)
- Scheduled work: [Cloud Scheduler HTTP targets](https://cloud.google.com/scheduler/docs/schedule-run-cron-job)
- Sign-in: [Google sign-in for the web](https://firebase.google.com/docs/auth/web/google-signin)
- Costs: [budgets](https://cloud.google.com/billing/docs/how-to/budgets)
