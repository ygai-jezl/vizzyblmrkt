# Start with Claude or Cursor

This guide takes you from nothing to YouGrow running on your laptop, using Claude Code or
Cursor to do the work. You need no accounts and no Google Cloud project: the app runs on
the Firebase emulators with a made-up demo brand. Expect to be signed in within about 15
minutes; the first run is the slowest because it downloads the emulators.

Then it shows what to ask next: how to find your way around, build a feature, check your
work, and host your own copy on Google Cloud.

The repo is set up for coding agents. [AGENTS.md](../AGENTS.md) tells the agent how the
project works, five step by step skills in `.claude/skills/` guide the common jobs, and
`.claude/settings.json` makes the agent ask before anything that touches the cloud. Claude
Code and Cursor both read these files, so you don't need to explain the project yourself.

## Before you start

| You need | Why | Check it |
| --- | --- | --- |
| Git | To clone the repo | `git --version` |
| Node 24 | Runs the app (Node 22 works; the doctor recommends 24) | `node -v` |
| Java 21 or newer | The Firestore emulator runs on Java | `java -version` |
| Claude Code or Cursor | Your coding agent | see below |

You don't need the Firebase CLI or gcloud for a local run. If the Firebase CLI isn't
installed, `npm run local` fetches a pinned copy with npx.

**Install your agent:**
- Claude Code: follow [the setup guide](https://code.claude.com/docs/en/setup), then run
  `claude` once in a terminal and sign in. You can also use the Code tab in the Claude
  desktop app, or Claude Code on the web (see [cloud agents](agents/cloud.md)).
- Cursor: download it from [cursor.com](https://cursor.com) and sign in.

Missing Node or Java? Don't worry yet: the first thing the agent runs is the doctor, which
says exactly what to install and how, for your operating system.

## 1. Get it running

### With Claude Code in a terminal

```bash
git clone https://github.com/ygai-jezl/vizzyblmrkt yougrow
cd yougrow
claude "Get YouGrow running on my laptop. Follow AGENTS.md."
```

What happens next:

1. Claude Code asks whether you trust this folder. Say yes: that lets the repo's settings,
   skills and safety rules load.
2. A start hook runs `npm run doctor -- --brief`, so the agent begins knowing what your
   machine has and lacks.
3. The agent runs `npm run doctor` and reads it. If something is missing (often Java 21),
   it shows you the fix command. Run it, or let the agent run it if you're happy to.
4. It asks before running `npm install`. Installing packages always asks first.
5. It starts `npm run local` in the background. This writes `.env.local` with local
   settings and fresh local secrets, starts the emulators, seeds a demo brand called
   **Acme**, starts the app and runs the scheduled work (journeys, emails, posts) every two
   minutes.
6. It tells you when the app is up, at **http://localhost:3002**, and how to sign in.

Claude Code may also ask once whether to use the Firebase MCP server that the repo lists.
It searches Google's developer docs and reads App Hosting rollout logs. It's optional: say
yes if you plan to host your own copy later.

### With Claude Code in the desktop app or on the web

Open the Code tab, pick the folder you cloned (or the repo, on the web), and send the same
prompt: `Get YouGrow running on my laptop. Follow AGENTS.md.` On the web the agent runs on
a fresh Linux machine, so set up its environment first: [docs/agents/cloud.md](agents/cloud.md)
has the setup script to paste.

### With Cursor

1. Clone the repo (the first two lines above), then open the `yougrow` folder in Cursor.
2. Open the agent chat and send: `Get YouGrow running on my laptop. Follow AGENTS.md.`
   Or click [this link](https://cursor.com/link/prompt?text=Get%20YouGrow%20running%20on%20my%20laptop.%20Follow%20AGENTS.md.),
   which fills in the same prompt.
3. Cursor reads `AGENTS.md`, `CLAUDE.md` and the skills in `.claude/skills/` by itself, and
   runs the repo's hooks, through its setting for Claude Code files. That setting is on by
   default; if the agent doesn't seem to know the project, check it's on.
4. Approve the terminal commands the agent proposes as it goes: the doctor, `npm install`,
   then `npm run local`.

If Cursor offers to enable the MCP server in `.cursor/mcp.json`, it's the same optional
Firebase server described above.

For Cursor's cloud agents, see [docs/agents/cloud.md](agents/cloud.md).

## 2. Sign in and look around

1. Open http://localhost:3002/login and click **Sign in with Google**.
2. A test page from the Auth emulator opens instead of Google. Pick **Demo Admin,
   admin@example.com** (or add that address if it isn't listed).
3. You land on the home page of the demo brand Acme, with the setup guide on the left.

Nothing you do here reaches the internet. Emails are written to the log instead of sent,
and your data stays in `.local/emulator-data` between runs. Ctrl-C (or asking the agent to
stop it) stops everything and keeps the data.

To start over with a clean demo: stop the app, delete `.local/emulator-data`, and run
`npm run local` again.

## 3. Turn on the AI features (optional)

AI writing, images and knowledge search need a Gemini key. Everything else works without one.

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Open `.env.local` yourself and set `GEMINI_API_KEY=` to it.
3. Restart the local run.

Do this step yourself rather than pasting the key into the chat. The agent can't open
`.env.local` anyway: the repo's settings stop it from reading secret files. Note that
Google's free tier may use what you send to improve its products, so use made-up data.

Vizzy, the in-app chat agent, runs on Google's Agent Runtime and needs a hosted copy, so
it isn't available in a local run.

## 4. What to ask next

Plain requests work. These are good starting points:

| You want to | Ask | The agent uses |
| --- | --- | --- |
| Understand the app | "Give me a tour of the admin. What does each section do, and where is its code?" | AGENTS.md, the code map |
| Understand one area | "How do lifecycle journeys work, from a sign-up to a sent email?" | `src/lib/lifecycle`, `src/lib/journey` |
| Build something | "Add a feature that ... It should ship behind a switch." | `build-a-feature`, `add-a-switch` |
| Fix a bug | "When I ..., I see ... Find out why and fix it, with a test." | `build-a-feature`, `check-my-change` |
| Check your work | "Check my change is ready for a pull request." | `check-my-change` |
| Fix the local run | "npm run local fails, here's what it says: ..." | `run-locally` |
| Host your own copy | "Host YouGrow on my Google Cloud project my-project-id. Follow docs/self-host.md." | `deploy-your-own` |

You can also start a skill directly: type `/` and its name, for example `/check-my-change`,
in Claude Code or Cursor.

Some habits that help:
- Ask for a plan first on bigger changes ("Plan this before you change anything").
- New behaviour ships behind a switch that is off by default. `npm run local` turns every
  switch on, so restart it after the agent adds one.
- When the agent says it's done, it should quote the test results (`npm run typecheck`,
  `npm run lint`, `npm test`). If it doesn't, ask.

## 5. Host your own copy on Google Cloud

When you're ready, ask: `Host YouGrow on my Google Cloud project my-project-id. Follow docs/self-host.md.`

The agent uses the `deploy-your-own` skill, which drives `npm run selfhost`:

1. It shows you a read-only plan: every step, whether it's done, and what it would change.
2. Before each step it tells you what will change in which project, and only goes ahead
   when you say yes.
3. A few things only you can do, because they need a browser or your own keys: signing in
   with `gcloud auth login`, `gcloud auth application-default login` and `firebase login`,
   connecting your GitHub fork to App Hosting, and turning on Google sign-in in the Firebase
   console. The agent tells you when, and waits.
4. At the end, `npm run doctor -- --cloud --project my-project-id` checks the result.

You need a Google Cloud project with billing turned on, and about 45 minutes, most of it
the first build. Costs and every step are in [docs/self-host.md](self-host.md).

## What your agent will and won't do

| Allowed by the repo, no extra prompt | Always asks you first | Never does |
| --- | --- | --- |
| Run the doctor, tests, lint, typecheck, build and smoke test | Any deploy or rollout | Read or print secret values, or open `.env.local` (blocked) |
| Start the local run | `npm run selfhost` steps that change a project | Force-push (blocked) |
| Show `git status`, `git diff`, `git log` | Scripts in `infra/`, and gcloud or firebase commands that change a project | Commit secrets or real people's data (an AGENTS.md rule) |
| | Installing or upgrading packages, `git push`, `git reset --hard`, `git clean` | Run the X sign-in setup script's `secret` command on a project that already has it: it would break every saved LinkedIn and X connection (an AGENTS.md rule) |

Editing files follows your agent's own approval settings, as in any project.

In **Claude Code** the first two columns and the blocks are enforced by
`.claude/settings.json`, and a hook names the Google Cloud project before any deploy-shaped
command and asks you to confirm.

In **Cursor**, the same hook runs and warns, but Cursor doesn't yet stop for it. Cursor's
own approval of terminal commands is your safeguard there, so read each command before you
approve it, especially anything with `deploy`, `selfhost` or `--apply`.

## The files that make this work

| File | What it does |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | The guide every agent reads first: commands, the code map, rules and known traps |
| `CLAUDE.md` | Loads AGENTS.md into Claude Code (Cursor reads both) |
| `agents/root_agent/AGENTS.md`, `workers/knowledge-scraper/AGENTS.md`, `infra/AGENTS.md`, `sdk/node/AGENTS.md` | Extra notes for those folders |
| `.claude/skills/` | The five skills: `run-locally`, `deploy-your-own`, `add-a-switch`, `build-a-feature`, `check-my-change` |
| `.claude/settings.json` | What the agent may do freely, what it asks first, what it can't read, and the start and deploy hooks |
| `.mcp.json`, `.cursor/mcp.json` | The optional Firebase MCP server (Google docs search, rollout logs) |
| `scripts/doctor.mjs` | `npm run doctor`: checks your machine and prints a fix for each problem |
| `scripts/local.mjs` | `npm run local`: the whole local setup in one command |

Your own tweaks go in `CLAUDE.local.md` or `.claude/settings.local.json`, which git ignores.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| The doctor says Java is missing or too old | Install Java 21 with the command it prints, open a new terminal, run `npm run doctor` again |
| A port is in use | Move it, for example `LOCAL_APP_PORT=3010 npm run local`. The doctor names the busy port; the other variables are in AGENTS.md |
| The first run seems stuck | It downloads the emulators and compiles the app. Watch `.local/local.log` |
| "Access denied" when signing in | Pick admin@example.com on the emulator's test page. Other addresses aren't on the admin list (`ADMIN_ALLOWED_EMAILS` in `.env.local`) |
| "This workspace isn't set up yet" | `.env.local` is missing `ADMIN_BOOTSTRAP_TENANT_ID`. Delete `.env.local` and run `npm run local` to write a fresh one |
| AI features say they're off | Add `GEMINI_API_KEY` to `.env.local` (step 3) and restart |
| The agent says it can't open `.env.local` | That's on purpose. Edit the file yourself |
| Cursor's agent doesn't know the project | Check Cursor's setting for Claude Code files is on, or ask it to read AGENTS.md |
| A query works locally but fails when hosted | The emulator doesn't enforce Firestore indexes. Add the index to `firestore.indexes.json` |

Still stuck? Ask the agent to run `npm run doctor -- --json` and explain what it says, or
open an issue on GitHub.

## Contributing back

Branch from `dev` and open a pull request against `dev`. Ask your agent to run the
`check-my-change` skill first. [CONTRIBUTING.md](../CONTRIBUTING.md) has the rest.
