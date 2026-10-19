# Run YouGrow with cloud coding agents

A cloud agent starts on a fresh Linux machine with no Google Cloud access, and YouGrow needs
none: `npm run local` runs the app on the Firebase emulators and the offline `demo-yougrow`
project. Each machine needs:

- **Node 24** (`.nvmrc`). Node 22 works too; the doctor says 24 is recommended.
- **Java 21**, for the Firestore emulator.
- **Network access** to the npm registry (`registry.npmjs.org`) and to
  `storage.googleapis.com`, where the Firebase CLI downloads the Firestore emulator and the
  emulator UI. The Auth emulator is part of the CLI. Nothing comes from Maven Central.

Then the steps in [AGENTS.md](../../AGENTS.md) work as on a laptop. Never run deploys, `infra/`
scripts or `npm run selfhost` from a cloud agent.

## Claude Code on the web

At [claude.ai/code](https://claude.ai/code), open your environment's settings and paste this
into the **Setup script** field. It lives in the environment, not in this repo.

```bash
#!/bin/bash
# YouGrow: Java 21, the pinned Firebase CLI and the emulator downloads.
java -version 2>&1 | grep -qE 'version "(2[1-9]|[3-9][0-9])' \
  || { apt-get update && apt-get install -y openjdk-21-jre-headless; } || true
npm install -g firebase-tools@15.27.0 || true
firebase setup:emulators:firestore || true
firebase setup:emulators:ui || true
# Dependencies, when the script starts in the repo. If not, the agent runs npm ci itself.
if [ -f package-lock.json ]; then npm ci || true; fi
exit 0
```

- The script runs as root on Ubuntu 24.04 and must exit 0, or the session doesn't start. When
  it finishes within about five minutes, the result is cached for later sessions. Java 21 is
  already installed there, so it is usually quick.
- The default **Trusted** network access is enough: it allows the npm registry and
  `*.googleapis.com`.
- Node 22 is on the path there. YouGrow runs on it.
- The repo's `CLAUDE.md` (which loads AGENTS.md), the skills in `.claude/skills/` and
  `.claude/settings.json` (its permission rules and hooks, including the doctor at start)
  apply in a session with one repository.
- Then ask: `Get YouGrow running. Follow AGENTS.md.`

Details: [Cloud environments](https://code.claude.com/docs/en/cloud-environments) and
[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).

## Cursor Cloud Agents

In the Cloud Agents dashboard, set up an environment for the repo:

- **Install:** `sudo apt-get update && sudo apt-get install -y openjdk-21-jre-headless && npm ci`
- **Start:** `npm run local` in a terminal. It keeps running, so it belongs in a terminal,
  which runs in a tmux session you share with the agent. A port taken? Use the `LOCAL_*_PORT`
  variables, for example `LOCAL_APP_PORT=3010 npm run local`.
- **Ports:** open the app from **Forwarded Ports** in the editor panel.
- **Secrets:** a local run needs none. Add one in the **Secrets** tab only for an optional
  feature, such as `GEMINI_API_KEY` for AI writing. Secrets arrive as environment variables.

Cloud agents read AGENTS.md, which has a "Cursor Cloud specific instructions" section.
Details: [Cursor cloud agent setup](https://cursor.com/docs/cloud-agent/setup).

## GitHub Codespaces and dev containers

`.devcontainer/` builds one image with Node 24, Java 21, the Google Cloud CLI and the
Firebase CLI, then runs `npm ci`.

1. Create a Codespace on the repo, or open the folder in VS Code and run
   **Dev Containers: Reopen in Container**.
2. Run `npm run local` and open the forwarded **App** port (3002).

Open a Codespace in VS Code on your desktop rather than in the browser: the desktop app
forwards ports to `localhost`, where the emulator sign-in expects them.

Self-hosting from the container? `npm run local` needs no sign-in, but the self-host steps
do, and there is no local browser: use `gcloud auth login --no-launch-browser`,
`gcloud auth application-default login --no-launch-browser` and `firebase login --no-localhost`.
