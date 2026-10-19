# Vizzy, the root agent

The Python ADK 2.x agent behind the dashboard chat, deployed to Agent Runtime (Vertex AI).
`README.md` in this folder has the full picture; this is the short version for coding agents.
The rules in the root `AGENTS.md` apply here too.

## Set up and test

The venv lives at `agents/.venv`, outside this package: `adk deploy` uploads this whole folder,
and a venv inside it breaks the 8 MB upload limit.

```bash
python3.12 -m venv agents/.venv
agents/.venv/bin/pip install -r agents/requirements-deploy.txt pytest
cd agents/root_agent
../.venv/bin/python -m pytest tests/ -q
```

Tests that need ADK start with `pytest.importorskip("google.adk")`, so most run without it.
CI doesn't run this suite: run it yourself after any change here and quote the summary line.

## How tools reach the app

- The agent never reads Firestore. Each tool POSTs to `$CANVAS_CALLBACK_URL/api/agent/<area>`
  with a short-lived context token in the `X-Canvas-Context` header. The app's chat proxy signs
  it; the route checks it with `verifyCanvasContext` and takes the tenant from it
  (`tenantContextFromCanvasToken`, both in `src/lib/canvas/auth.ts`), never from the body.
- Context arrives as a `[ctx:{...}]` message prefix that `callbacks/context_envelope.py` moves
  into session state. `[mode:...]` sets thinking (`callbacks/chat_mode.py`).
- Keep request logic in a pure `tools/*_client.py`, tested without ADK, with a thin ADK wrapper
  beside it. When the app has the feature switched off, the tool says so in plain words.
- Anything the agent writes is a draft or a suggestion that a person accepts in the app.
- A new tool needs: its route under `src/app/api/agent/` (check the token, then `forTenant(ctx)`),
  tests for its client, and its wrapper in `tests/test_tool_declarations.py`.

## Deploy: ask first

`deploy.sh` deploys to a real Google Cloud project. Show the dry run, then wait for a yes:

```bash
PROJECT=<id> CANVAS_CALLBACK_URL=https://<app-origin> bash agents/root_agent/deploy.sh --dry-run
```

- Without `AGENT_ENGINE_ID` it creates a new engine; with it, it updates that engine in place.
- `infra/agent/setup.sh all <project>` makes the agent's service account first (ask first too).
  `npm run selfhost -- --project <id> --apply addon:vizzy` does both steps.

## Gotchas

- The folder name `root_agent` is the ADK app name and must stay a valid Python identifier.
- `requirements.txt`: pin `google-adk` to the local `adk --version`, keep the `[a2a]` extra,
  and don't pin `google-genai` or `aiplatform`.
- `DEFAULT_MODEL` in `model_config.py` and `ROOT_AGENT_MODEL` in `deploy.sh` move together.
