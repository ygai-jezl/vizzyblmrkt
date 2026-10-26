# AGENTS.md

The guide for coding agents (Claude Code, Cursor and others) and for people working on YouGrow.

YouGrow is an open-source growth platform: waitlists, lifecycle journeys, content and social posts, run with an AI agent called Vizzy.
It is a Next.js 15 app on Firebase App Hosting with Firestore, Firebase Auth, Gemini on Vertex AI and a Python ADK agent, and anyone can host it on their own Google Cloud.

## Start here

1. `npm run doctor` checks Node 24, Java 21, the Firebase CLI, free ports and `.env.local`. Each problem prints its fix.
2. `npm install` if the doctor says dependencies are missing (`npm ci` on a fresh machine).
3. `npm run local` runs the app on the Firebase emulators: the offline project `demo-yougrow`, no accounts, nothing reaches Google. It keeps running, so start it in the background and wait for the `App: http://localhost:3002` line. The first run takes a few minutes. Log: `.local/local.log`.
4. Open http://localhost:3002, click **Sign in with Google**, then pick or add `admin@example.com` on the emulator's test page. You land in the demo brand Acme (`ten_demo`).

Ports busy? Move them, for example `LOCAL_APP_PORT=3010 npm run local`. The others are `LOCAL_FIRESTORE_PORT`, `LOCAL_AUTH_PORT`, `LOCAL_UI_PORT`, `LOCAL_HUB_PORT`, `LOCAL_LOGGING_PORT` and `LOCAL_FIRESTORE_WS_PORT`.
AI writing, images and knowledge search need `GEMINI_API_KEY` in `.env.local`. The user adds it themselves, never through the chat. Everything else works without it.

## Skills

Step by step guides in `.claude/skills/<name>/SKILL.md`. Claude Code and Cursor both load them. Open the one that fits before you start:

- `run-locally`: use it when someone wants YouGrow running on their machine, or the local run fails.
- `deploy-your-own`: use it when someone wants their own copy on their Google Cloud project (`npm run selfhost`).
- `add-a-switch`: use it when a change needs a feature switch, or a switch is renamed or removed.
- `build-a-feature`: use it before you write a new feature, API route or screen.
- `check-my-change`: use it before you say a change is done or open a pull request.

## Commands

| Command | What it does |
| --- | --- |
| `npm run doctor` | Checks this machine (`-- --brief` for one line, `-- --json` for tools) |
| `npm run local` | App plus emulators, seeded, scheduled work every 2 minutes |
| `npm run typecheck` | TypeScript, no output files |
| `npm run lint` | ESLint, including the tenant isolation rule |
| `npm test` | All unit tests with Vitest (`npx vitest run <path>` for one file) |
| `npm run build` | Production build |
| `npm run smoke` | End to end test on throwaway emulators (needs Java; builds first when there is no build) |
| `npm run check:instance` | Fails when code names one hosted copy (its domains, projects or tenants) |
| `npm run check:private-paths` | Fails on files that belong only in a deployment's private repo |
| `npm run agents:check` | Fails when a guide names a script or path that isn't there, or `.env.example` misses a variable |
| `npm run doctor -- --cloud --project <id>` | Read-only checks of a Google Cloud project |
| `npm run selfhost -- --project <id>` | The self-host plan, read-only. `--apply <step>` changes the project |

## Where things live

- `src/app`: routes. `admin/` is the admin portal, `api/admin/` its APIs, `api/agent/` the routes Vizzy's tools call, `api/v2/` the API for connected products, `waitlist/` and `embed/` the public sign-up pages, `help/` the public how-tos.
- `src/lib`: the logic. `tenant/` is the only code that touches Firestore. Also `auth/` (sessions, admin access), `http/` (origin checks), `lifecycle/` and `journey/` (journeys), `email/`, `distribute/` and `social/` (posts), `knowledge/` and `agents/` (AI and retrieval), `help/` (help page list), `content/writingRules.ts` (house style), `waitlist/siteKeys.ts` (a launch's site key, for sign-ups from a brand's own site).
- `src/components`: React components. Help page bodies are in `src/components/help/pages/`.
- `agents/root_agent`: Vizzy, the Python ADK agent. It has its own AGENTS.md.
- `workers/knowledge-scraper`: the Cloud Run Job that reads sites and repos into knowledge. Own AGENTS.md.
- `infra`: setup scripts, each for one Google Cloud project. Own AGENTS.md.
- `sdk/node`: the MIT Node SDK, `@yougrowai/node`. Own AGENTS.md.
- `scripts`: doctor, local run, self-host, checks and seed. `docs`: architecture, decisions, self-hosting.

## The one rule

Never call Firestore directly. Get a tenant context on the server (`resolveTenantFromOrigin` for public requests, `getAdminContext()` from `@/lib/auth/session` in admin routes), then use `forTenant(ctx)` from `@/lib/tenant`.
`ctx.tenantId` always comes from the server, never from a request body, query or header. ESLint bans raw Firestore calls and imports outside `src/lib/tenant/**`: never turn the rule off. Why: `docs/ARCHITECTURE-AND-DELIVERY.md` section 4.

## Switches

- New features ship off. Read a switch as `process.env.MY_FEATURE_ENABLED === "true"`, so anything else means off.
- List it in `apphosting.yaml` with `value: "false"` in its group, and in `.env.example` left empty.
- `NEXT_PUBLIC_*` switches need `BUILD` and `RUNTIME` availability, and are fixed at build time: changing one needs a new build.
- `scripts/config/feature-switches.test.ts` (part of `npm test`) fails when a switch the code reads is missing from `apphosting.yaml`, isn't `"false"` there, or lacks `BUILD`.
- `npm run local` turns on every `*_ENABLED` switch in `apphosting.yaml`, so restart it after adding one. Deployments turn switches on in their own `apphosting.<env>.yaml`.

## Secrets and settings

- Secrets live in Secret Manager and are referenced by name (`secret: email-worker-secret`) from a deployment's `apphosting.<env>.yaml` only. Never print, log, paste or commit a value. Never ask the user to paste one into the chat: the scripts ask in the user's own terminal.
- `.env.local` is local only and git ignored. `npm run local` writes it. Agents can't open it (`.claude/settings.json` denies it), so ask the user to edit it.
- Never point a local run at a real project. `npm run local` always forces `demo-yougrow` and the emulators; don't put a real project id in `.env.local`.
- Keep a deployment's values out of commits: project ids, domains, emails, `apphosting.<env>.yaml`, `.firebaserc`. Tests use made-up people at `example.com` or `.test`.

## Boundaries

Always:
- Run `npm run doctor` first and read what it says.
- Build behind a switch, through `forTenant(ctx)`, with tests.
- Run typecheck, lint and test before you say you're done.
- Name the Google Cloud project a command will touch before you run it.

Ask first:
- Any deploy or rollout: `firebase deploy`, `firebase apphosting:*`, any `deploy.sh`, `adk deploy`.
- `npm run selfhost -- ... --apply`: show what the step changes, and add `--yes` only after the user agrees.
- Any script in `infra/`, and `gcloud`, `firebase`, `gsutil` or `bq` commands that change a project.
- Adding or upgrading a dependency.
- Changing `firestore.indexes.json` or `firestore.rules`.
- Deleting files.
- `git push`.

Never:
- Commit secrets, a deployment's settings, or real people's names, emails or phone numbers.
- Read or print secret values (`gcloud secrets versions access`, `.env.local`, key files).
- Run `infra/x-oauth/setup.sh secret` on a project that already has it. It rotates `social-token-enc-key`, the shared key for every stored LinkedIn and X token, so every connection breaks.
- Force-push, or rewrite the history of `dev` or `main`.

## Known traps

- A secret that `apphosting.<env>.yaml` names but the project lacks, or the backend can't read, fails the App Hosting build with `Error resolving secret version`.
- `NEXT_PUBLIC_*` values are baked in at build time. Changing one means a new build and rollout.
- `next dev` and `next build` share `.next`. Stop `npm run local` before `npm run build` or `npm run smoke`, and start it again after.
- The emulators need Java 21 or newer.
- The Firestore emulator doesn't enforce composite indexes. A query that needs one passes locally and fails when deployed: add it to `firestore.indexes.json` (ask first).
- Lifecycle emails are skipped without a privacy policy URL (the brand's own, or `EMAIL_DEFAULT_PRIVACY_URL`).
- `LIFECYCLE_MODE_CEILING` unset means test mode: product journeys send nothing real until it is `"live"`.
- A change to a screen, setup step or message people see needs its help page in `src/components/help/pages/`. `src/lib/help/help.test.ts` checks the links, sections and quoted messages.
- Product copy follows `src/lib/content/writingRules.ts`: no em dashes, en dashes or spaced hyphens as punctuation (`NO_DASHES`), and none of the `AI_TELLS` phrases.

## Testing

- Vitest, with tests beside the code (`*.test.ts`). For data use the in-memory `FakeFirestore` from `src/lib/tenant/testing/fakeFirestore.ts`: no emulator needed.
- Route tests mock `@/lib/auth/session`; `src/app/api/admin/brand-kit/email-style/route.test.ts` is a good model.
- Vizzy: pytest in `agents/root_agent` (see its AGENTS.md). The scraper: `npm test` inside `workers/knowledge-scraper`.
- `npm run smoke` covers sign-up, sign-in and a connected-product journey end to end.

## Finishing

Run `npm run typecheck`, `npm run lint` and `npm test`, and quote their summary lines in your report (Vitest's `Test Files` and `Tests` lines).
Branch from `dev` and open pull requests against `dev`, one piece of work each, using `.github/pull_request_template.md`. `CONTRIBUTING.md` has the rest.

## Cursor Cloud specific instructions

Cloud agents start on a fresh Ubuntu machine with no Google Cloud access, and need none:

- Install Node 24 (`.nvmrc`) and Java 21: `sudo apt-get install -y openjdk-21-jre-headless`.
- Run `npm ci`, then `npm run doctor`.
- Run `npm run local` in a background terminal and wait for the `App:` line. With no Firebase CLI installed it fetches `firebase-tools@15.27.0` with npx, so it needs npm registry access. If a port is taken, use the `LOCAL_*_PORT` variables.
- The app runs on the offline `demo-yougrow` project. Don't run deploys, `infra/` scripts or `npm run selfhost` from a cloud agent.
- Check your work with `npm run typecheck`, `npm run lint` and `npm test`.
- Install and start commands for Cursor's environment settings, Claude Code on the web and dev containers: `docs/agents/cloud.md`.
