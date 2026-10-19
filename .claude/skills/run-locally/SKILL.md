---
name: run-locally
description: Get YouGrow running on this machine on the Firebase emulators (no accounts, no Google Cloud), and fix a local run that fails. Use it when someone asks to run, start, set up or try YouGrow locally, when npm run local or npm run doctor fails, or when signing in on localhost doesn't work.
---

# Run YouGrow locally

The goal: the app at http://localhost:3002 on the offline emulator project `demo-yougrow`,
signed in as the demo admin. Nothing here touches a real Google Cloud project.

## 1. Check the machine

```bash
npm run doctor
```

Each line starts with `ok`, `fail`, `warn` or `info`, and every problem has a `fix:` line.
Fix the `fail` lines; `warn` and `info` can wait. The usual ones:

- Node older than 24: `nvm install 24 && nvm use 24` (the repo's `.nvmrc` says 24).
- Java missing or older than 21: the doctor prints the install command for this OS
  (`brew install openjdk@21` on macOS, `sudo apt-get install -y openjdk-21-jre-headless` on
  Debian or Ubuntu). Installing system software is the user's call: show the command and ask.
- Dependencies missing: `npm install` (or `npm ci` for an exact install from the lockfile).
- A port in use: see step 3.

Run `npm run doctor` again until the summary says `0 failed checks`.

## 2. Start it

```bash
npm run local
```

- It runs until Ctrl-C. In Claude Code start it with `run_in_background`; in Cursor use a
  background terminal. Then wait for the lines that end with
  `App: http://localhost:3002` and `Sign in: click "Sign in with Google" ...`.
- The first run takes a few minutes: it downloads the emulators, and fetches
  `firebase-tools@15.27.0` with npx when there is no Firebase CLI 14 or newer.
- The first time, it writes `.env.local` from `scripts/local-env.template`, with every feature
  switch in `apphosting.yaml` turned on except the few in `SWITCHES_KEPT_OFF`
  (`scripts/lib/local-env.mjs`). A `.env.local` it didn't write is left alone, and the doctor
  warns about it.
- It seeds the demo brand and calls the scheduled-work routes (journeys, emails, posts)
  every 2 minutes, as Cloud Scheduler does in a deployment.
- Everything else goes to `.local/local.log`. Emulator data stays in `.local/emulator-data`
  between runs.

## 3. Ports

Defaults: app 3002, Firestore 8080, Auth 9099, emulator UI 4000, hub 4400, logging 4500,
Firestore websocket 9150. Move any of them for one run:

```bash
LOCAL_APP_PORT=3010 LOCAL_FIRESTORE_PORT=8085 npm run local
```

The variables: `LOCAL_APP_PORT`, `LOCAL_FIRESTORE_PORT`, `LOCAL_AUTH_PORT`, `LOCAL_UI_PORT`,
`LOCAL_HUB_PORT`, `LOCAL_LOGGING_PORT`, `LOCAL_FIRESTORE_WS_PORT`. To see what holds a port:
`lsof -nP -iTCP:<port> -sTCP:LISTEN`. Don't stop a process you didn't start without asking.

## 4. Sign in

Open the `App:` address and click **Sign in with Google**. The Auth emulator shows a test page
instead of Google: pick or add `admin@example.com` (any display name). You land in the demo
brand Acme (`ten_demo`). Other emails are refused; the list is `ADMIN_ALLOWED_EMAILS` in
`.env.local`.

## 5. Optional: AI features

AI writing, images and knowledge search need a Gemini API key. The user gets one at
https://aistudio.google.com/apikey and adds `GEMINI_API_KEY=<key>` to `.env.local` themselves.
You can't open that file, and you must never ask for the key in the chat. Then restart
`npm run local`.

## When it fails

- "The local run stopped before the app was ready": it prints the last log lines. The rest is
  in `.local/local.log`.
- Emulator errors about Java: Java 21 or newer must come first on `PATH` (`java -version`).
- Strange build errors after `npm run build` or `npm run smoke`: they share `.next` with the
  dev server. Stop the local run, delete `.next` (ask first), start again.
- "The first scheduled-work tick failed": the log shows the route's error. It is usually a
  real bug in that route, worth fixing.
- To start from a clean slate: stop the run, then delete `.local/emulator-data` (ask first).
  The next run seeds the demo brand again.

## Report

Tell the user the address, how to sign in, and any `warn` lines from the doctor they may want
to fix later.
