---
name: deploy-your-own
description: Host YouGrow on the user's own Google Cloud project with npm run selfhost. Show the read-only plan, get the user's go-ahead for each step, apply it with --yes, and verify with npm run doctor -- --cloud. Use it when someone wants to deploy, host or self-host their own copy, add an add-on (email, Vizzy, knowledge, GitHub App, LinkedIn, X, regions, BigQuery, reCAPTCHA), or fix a self-hosted copy.
---

# Deploy your own copy

Every `--apply` changes a real Google Cloud project and can cost money. The user decides; you
run the steps and explain them. `docs/self-host.md` is the full guide: read it first.

## Rules

- Never apply a step without the user's yes for that step, in this conversation. "Host it for
  me" is not a yes to every step: show what each step changes first.
- Never print, log or ask for a secret. Steps that need a key (email, LinkedIn, X) ask for it in
  the terminal: the user runs those commands in their own terminal.
- Never run `infra/x-oauth/setup.sh secret`; `--apply addon:x` sets up X safely.
- Name the project in every message about a change.
- Stop at the first error. Show it, explain it, and suggest the fix the tool printed.

## 1. Before you start

Ask the user for:

- The project id (6 to 30 lowercase letters, digits and hyphens). A new project:
  `gcloud projects create <id>` (ask first), then link billing in the console.
- Whether billing is on. App Hosting needs the pay as you go (Blaze) plan.
- The Firestore location. It is permanent; the default is `nam5` (US).

Tools: the Google Cloud CLI signed in twice (`gcloud auth login` and
`gcloud auth application-default login`), and the Firebase CLI 14.4 or newer with
`firebase login`. The user runs the logins: they open a browser.
Suggest a budget alert before anything is created (see "What it costs" in `docs/self-host.md`).

## 2. Show the plan

```bash
npm run selfhost -- --project <id>
```

It only reads. It lists each core step as done, to do or can't tell, and prints the next
command. Summarise it for the user in a short table. Options: `--region` (default
`us-central1`), `--env` (default `live`, so the settings file is `apphosting.live.yaml`),
`--backend` (default: the project id).

## 3. Apply one step at a time

The core steps, in order: `account`, `apis`, `firebase`, `firestore`, `storage`, `secrets`,
`workspace`, `backend`, `connect`, `envfile`, `signin`, `scheduler`, `rollout`. For each one
that is to do:

1. Say what it changes (the table under "Run the core steps" in `docs/self-host.md`).
2. Get a yes.
3. Run it with `--yes` and the answers it needs:

   ```bash
   npm run selfhost -- --project <id> --apply <step> --yes [answers]
   ```

   - `firestore`: `--location nam5` (or the location the user chose)
   - `workspace`: `--workspace-name "<brand name>" --workspace-domain <their domain>`, plus
     `--workspace-region eu` or `asia` for data that must stay outside the US
   - `envfile`: `--admin-email <their Google email> --privacy-url <their https privacy page>`

   Ask the user for every value. Never make up an email, domain or URL.
4. Read the output. `Done:` means it worked. `Not confirmed yet:` or a stop means read what it
   says and follow it.
5. Run the plan again to confirm, then go on.

- `signin` needs the Firebase console once: it prints the links, the user clicks through, then
  run the step again.
- `rollout` builds and rolls out the app (several minutes, longer the first time) and checks
  `/api/health`. Run it in the background and read the result when it ends; don't poll.

## 4. Verify

```bash
npm run doctor -- --cloud --project <id>
```

Every line should start with `ok`. The app is at `https://<backend>--<project>.us-central1.hosted.app`:
the user opens it and signs in with Google using the admin email.

## 5. Add-ons, when the user wants them

```bash
npm run selfhost -- --project <id> --apply addon:<name>
```

Names: `email`, `vizzy`, `knowledge`, `github-app`, `linkedin`, `x`, `regions`, `bigquery`,
`recaptcha`. Same rules: explain, get a yes, apply. `email`, `linkedin` and `x` ask for keys,
so give the user the exact command to run in their own terminal. Afterwards roll out:
`--apply rollout` (ask first). Product journeys stay in test mode until the user adds
`LIFECYCLE_MODE_CEILING: "live"` to their settings file.

## Their settings file

`apphosting.live.yaml` holds their project id, admin email, switches and secret names (never
values). It belongs in their fork, never in a pull request to the upstream repo.

## When something goes wrong

Run `npm run doctor -- --cloud --project <id>` and follow its `fix:` lines. The table at the end
of `docs/self-host.md` covers the common cases (`Error resolving secret version`, a sign-in
domain that isn't authorised, "Access denied", scheduled jobs failing with 401). Build logs are
in the Firebase console (App Hosting, the backend, Rollouts), or through the Firebase MCP tool
`apphosting_fetch_logs` when that server is connected.
