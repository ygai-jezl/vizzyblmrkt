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
| `addon:search` | Search that finds what a brand wrote by its words and its meaning, for people and Vizzy | Automated. Makes a Firestore Enterprise database per region you use, which bills by data read and written. Needs the `gcloud beta` component. Fill it afterwards with `npx tsx scripts/search-backfill.ts` |
| `addon:recaptcha` | reCAPTCHA on waitlist sign-ups | Automated |

**Reranking search results.** `SEARCH_RERANK_ENABLED` reorders a US brand's search results with
Google's Ranking API (it runs only in the US and global locations, so EU and Asia brands keep the
merged order). Turn on the Discovery Engine API (`gcloud services enable discoveryengine.googleapis.com`),
give the App Hosting runtime service account a role with `discoveryengine.rankingConfigs.rank`, then
set the switch to `"true"`. Without it, or if a call fails, search keeps its merged order.

**Cancelling access on Disconnect.** `npm run selfhost` turns on `CONNECTOR_REVOKE_ENABLED`, so
Disconnect also cancels YouGrow's access at GitLab and on an older GitHub connection. It leaves
`CONNECTOR_REVOKE_X_ENABLED` off: an X account connected to two brands may share one grant, so
cancelling it for one brand could end the other's access. Connect one X account to two test brands,
press Disconnect on one, and check the other still posts. Then set the switch to `"true"`.

Each add-on writes its settings into `apphosting.live.yaml` and turns its switches on.
Roll out afterwards: `npm run selfhost -- --project <id> --apply rollout` (or push).

**Vizzy in Edit mode.** `NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED` lets people select text in Edit
mode and ask Vizzy to change it. It needs Gemini, which `addon:vizzy` sets up. For Vizzy to also
learn how each person likes their edits, run `DRY_RUN=1 bash infra/agent/setup.sh memory <your-project-id>`
to see what it does, then run it without `DRY_RUN`. It makes a Memory Bank and lets the app read and
write only memories scoped to a brand. Put the id it prints in your settings as `VIZZY_MEMORY_BANK_ID`
and set `EDIT_MODE_VIZZY_LEARNING_ENABLED` to `"true"`. Every brand gets it, and each person can switch
it off. To keep it for some brands only, set `GRANTED_ONLY_FEATURES` to `edit_vizzy_learning` and grant
brands with `scripts/grant-feature.ts`.

**Competitors.** `COMPETITORS_ENABLED` and `NEXT_PUBLIC_COMPETITORS_ENABLED` add Brand › Competitors:
a person types a competitor's website and presses Monitor, and the app reads that site's sitemap, then
checks its news page every week and its sitemap every month. That means your copy fetches other
businesses' public pages (it obeys their robots.txt and names itself `YouGrowBot`) and calls Gemini
to describe what it finds. The checks ride the lifecycle tick, so they need its Cloud Scheduler job.
Each brand can watch up to 10 competitors. To keep it for some brands only, add `competitors` to
`GRANTED_ONLY_FEATURES` and grant brands with `scripts/grant-feature.ts`. Some sites sit behind a
bot screen that turns away readers on cloud servers like yours. With `COMPETITORS_GOOGLE_READER_ENABLED`
the app reads such a site's news through Gemini's URL reader instead, which costs a model call on
every weekly check. Without it, the competitor's page says the site can't be read.
`COMPETITOR_ARTICLES_ENABLED` reads each competitor article in full (what it covers, who it is for, the
stats, links and calls to action it uses), with one Gemini call per article and at most 200 a month
per brand; add `competitor_articles` to `GRANTED_ONLY_FEATURES` to keep it for some brands.
`COMPETITOR_ARTICLES_PLANNING_ENABLED` then feeds what they wrote into the brand map, Suggest an angle,
blog research and the writer.

**Connected data.** `CONNECTORS_ENABLED`, `NEXT_PUBLIC_CONNECTORS_ENABLED` and
`CONNECTOR_CLOUDFLARE_ENABLED` let a brand's admins connect outside sources and read their numbers
live, each number with its meaning. `npm run selfhost` keeps all three off: connected data is new,
so turn it on by hand once you have read this.

- Tokens are sealed with `CONNECTORS_VAULT_KEY`, a core secret the `secrets` step makes as
  `connectors-vault-key`. Without it, connecting is refused.
- Each change to a connection is kept 90 days. The time to live that deletes older rows is set by
  `bash infra/lifecycle/setup.sh ttl <your-project-id>`, which the `connect` step runs on a new
  copy. A copy set up before connected data runs it once by hand; it is safe to run again.
- Cloudflare needs nothing else on your side: an admin pastes a read only token (Zone, Analytics,
  Read) and the site's Zone ID.
- To change the vault key: add a new version of `connectors-vault-key`, set the old value as
  `CONNECTORS_VAULT_KEY_PREVIOUS` (a secret too), roll out, then run
  `npx tsx scripts/reseal-connector-secrets.ts` as a dry run and again with `--apply`. Remove
  `CONNECTORS_VAULT_KEY_PREVIOUS` only when the dry run counts 0 off the current key. The script's
  first lines say how to pass both keys.
- To remove a brand's connected data, run `npx tsx scripts/connectors-purge.ts --tenant <id>`
  (a dry run), then add `--apply --by <label>`. Turning the switch off keeps the data sealed and
  unused; the purge is how it goes.

**Connect Google data on your own copy.** `CONNECTOR_SEARCH_CONSOLE_ENABLED` lets an admin connect
Google Search Console by signing in with Google. It needs a Google sign in client of your own, kept
in a Google Cloud project used only for it, so your app project's own admin sign in never goes
through Google's app checks. `npm run selfhost` keeps the switch off. Pick a neutral project id:
the people who sign in see your app's name and support email on Google's screen.

1. Make the project and turn on the Search Console API (these change only the new project):
   `gcloud projects create <identities-project-id>`, then
   `gcloud services enable searchconsole.googleapis.com --project <identities-project-id>`.
2. In the Google Cloud console, open **Google Auth Platform** for that project.
   - **Branding:** your app's name and a support email.
   - **Audience:** External. While it says Testing, add the Google accounts that will sign in;
     Google ends their sign ins after 7 days until you publish it.
   - **Data Access:** add `https://www.googleapis.com/auth/webmasters.readonly`. Google classes it
     as non sensitive, so publishing needs only Google's brand check, which takes a few days.
   - **Clients:** create a Web application client with the redirect address
     `https://<your app address>/api/admin/connectors/callback`. Add
     `http://localhost:3002/api/admin/connectors/callback` too if you will try it locally.
3. Store the client's secret on your app project (the command asks for it in your terminal) and
   give the backend access:
   `firebase apphosting:secrets:set connector-google-client-secret --project <your-project-id>`, then
   `firebase apphosting:secrets:grantaccess connector-google-client-secret --backend <backend> --project <your-project-id>`.
4. In `apphosting.live.yaml`, set `CONNECTOR_GOOGLE_CLIENT_ID` to the client id (not a secret),
   `CONNECTORS_OAUTH_ORIGIN` to `https://<your app address>` (the redirect's origin: without it a
   production server refuses to start a sign in, rather than trust the request's host), and
   `CONNECTOR_GOOGLE_CLIENT_SECRET` by name, `secret: connector-google-client-secret`. Then set
   `CONNECTORS_ENABLED` and `CONNECTOR_SEARCH_CONSOLE_ENABLED` to `"true"` and roll out.
5. Publish the consent screen (Audience, Publish app) before people rely on it, or every
   connection asks to reconnect each week.

- Sign in states last 10 minutes and are removed by the time to live that
  `bash infra/lifecycle/setup.sh ttl <your-project-id>` sets, with the activity's.
- Google keeps at most 100 sign ins for one Google account with your client; the 101st quietly ends
  the oldest. The help page says so.
- `CONNECTOR_GOOGLE_REVOKE_ENABLED` stays off: on, Disconnect also revokes the sign in at Google,
  which ends every grant that Google account gave your app, for every brand. Off, Disconnect deletes
  the tokens YouGrow keeps and the help page says how to remove access in a Google account.
- A local run (`npm run local`) needs no origin: it uses `http://localhost:3002`. Add
  `CONNECTOR_GOOGLE_CLIENT_ID` and `CONNECTOR_GOOGLE_CLIENT_SECRET` to `.env.local` yourself.

**Google Analytics and share access.** `CONNECTOR_GA4_ENABLED` adds Google Analytics 4 the same way.
Its permission, `https://www.googleapis.com/auth/analytics.readonly`, is one Google classes as
sensitive: add it under **Data Access** too, and Sign in with Google for it waits for Google's
sensitive scope review (a privacy policy line saying your app reads these numbers helps). Share
access needs no review: an admin adds a Google address that YouGrow makes for that one connection to
their Search Console site (as a Restricted user) or Google Analytics property (as a Viewer). It
needs the identities project above, and `npm run selfhost` keeps the switch off.

1. Turn on the APIs it calls (these change only the projects named): `gcloud services enable
   iam.googleapis.com iamcredentials.googleapis.com analyticsdata.googleapis.com
   analyticsadmin.googleapis.com searchconsole.googleapis.com --project <identities-project-id>`, then
   `gcloud services enable iamcredentials.googleapis.com --project <your-project-id>`.
2. Give your backend's runtime account three roles on the identities project only, never Service
   Account Admin or Token Creator. First a role that only mints tokens:
   `gcloud iam roles create connectorTokenMinter --project <identities-project-id> --title="Connector token minter" --permissions=iam.serviceAccounts.getAccessToken --stage=GA`.
   Then, for `--member=serviceAccount:firebase-app-hosting-compute@<your-project-id>.iam.gserviceaccount.com`,
   run `gcloud projects add-iam-policy-binding <identities-project-id>` three times, with
   `--role=roles/iam.serviceAccountCreator`, `--role=roles/iam.serviceAccountDeleter` and
   `--role=projects/<identities-project-id>/roles/connectorTokenMinter`.
3. In `apphosting.live.yaml`, set `CONNECTORS_IDENTITIES_PROJECT` to the identities project's id (not
   a secret), and set `CONNECTOR_GA4_ENABLED` to `"true"` if you want Google Analytics. Roll out.

- Each connection's address lives in the identities project and its tokens last 5 minutes; YouGrow
  stores none. Disconnect deletes the address. Its entry stays in the property's users, harmless.
- A project holds a limited number of service accounts (100 unless Google raises it; deleted ones
  don't count). Ask for more on the identities project's quotas page (Service Account Count) before
  you need it. When it is full, share access says so and offers Sign in with Google. One brand
  holds at most 5 addresses per connector, so no brand can fill the project for the others.
- If your projects sit in an organisation, turn on the policy `iam.disableServiceAccountKeyCreation`
  for the identities project: YouGrow never makes keys.
- A delete that failed is recorded and retried by
  `npx tsx scripts/connectors-purge.ts --tenant <id> --addresses` (a dry run; add
  `--apply --by <label>`), which also deletes any address no live connection owns. Your Application
  Default Credentials need to list and delete service accounts in the identities project.
- Without `CONNECTORS_IDENTITIES_PROJECT`, share access isn't offered and Sign in with Google still
  works.

**Vizzy reading connected data.** `CONNECTORS_CHAT_ENABLED` lets Vizzy list a brand's connections and
read them live (addon `vizzy`, and a Vizzy redeploy with its connector tools). Vizzy reads only the
connections an admin lets it read, never changes one, and every number it gives has its meaning.
`npm run selfhost` keeps it off.

**Plans stay off.** `PLANS_ENABLED` and `NEXT_PUBLIC_PLANS_ENABLED` are the hosted service's plans
(Free, Pro, Ultra and Enterprise). Leave both `"false"`; `npm run selfhost` keeps them off. Every brand
may then use every feature its switch turns on, and `GRANTED_ONLY_FEATURES` with
`scripts/grant-feature.ts` still works as above.

- The `workspace` step (`scripts/selfhost/create-workspace.ts`) gives your first brand an organisation
  on the Self-hosted plan, which stays open even if plans are turned on.
- `PLANS_NEW_ORGANISATION_PLAN` left empty means brands made in the app start on Self-hosted too.
- To turn plans on in a copy that already has brands: brands with no organisation stay open, but give
  each one an organisation first, so Settings › Plan and usage shows them. Run these in order:
  1. `GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/backfill-organisations.ts --plan self_hosted`
     (a dry run that changes nothing);
  2. the same command with `--apply --by <label>` added, which writes;
  3. `GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/backfill-organisations.ts --check`
     (with no other flags), which should say every brand and organisation agree;
  4. set both switches to `"true"` and roll out.
- `scripts/set-plan.ts` shows or changes an organisation's plan, name and owners, and
  `scripts/move-brand.ts` puts a brand on another organisation's plan or back on its own. Both are dry
  runs until you add `--apply --by <label>`, and refuse a change that narrows or widens access unless
  you add `--allow-narrower` or `--allow-wider`.

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
  `NEXT_PUBLIC_PLATFORM_ORIGIN`, `EMAIL_LINK_ORIGIN` and `CONNECT_ISSUER` to it (and
  `CONNECTORS_OAUTH_ORIGIN`, with the new redirect address on your Google client, if you use
  Sign in with Google for connected data), add it to the authorised domains, re-point the scheduled jobs with `--app-url https://<domain>
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

**Upgrading to connected data.** It adds a core secret, `connectors-vault-key`. On a copy set up
before it, `npm run doctor -- --cloud` reports it missing. Run
`npm run selfhost -- --project <id> --apply core` before you roll out: the `secrets` step makes
the key, the `backend` step gives the backend access to every secret added since it last ran,
and the `envfile` step adds `CONNECTORS_VAULT_KEY` to your settings file by name. Then run
`bash infra/lifecycle/setup.sh ttl <id>` once for its time to live (see Connected data above),
and roll out.

**Upgrading to Sign in with Google for connected data.** Nothing changes until you follow Connect
Google data on your own copy above. Run `bash infra/lifecycle/setup.sh ttl <id>` once more, for the
sign in states' time to live; it is safe to run again.

### Enterprise features

Merging upstream brings `src/ee`, the Enterprise code. Its features stay off without a
licence key, and none is released yet. To add a key once you have one:

1. Create the secret: `firebase apphosting:secrets:set enterprise-licence-key --project <id>`.
2. Give the backend access:
   `firebase apphosting:secrets:grantaccess enterprise-licence-key --backend <backend> --project <id>`.
3. Only then add `ENTERPRISE_LICENCE_KEY` to `apphosting.live.yaml` as
   `secret: enterprise-licence-key` (see [Your settings file](#your-settings-file)), and
   roll out.

**Keep that order.** A secret your settings file names but the project lacks, or the
backend can't read, fails the build with `Error resolving secret version`. Deleting `src/ee` gives a build with no
Enterprise code.

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
- Vizzy's memory: [Memory Bank](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank),
  [scopes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/fetch-memories),
  [IAM conditions on scope](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/iam-conditions)
