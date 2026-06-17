# Vizzybl Marketing — Root Orchestrator Agent (ADK 2.0)

The backend for the dashboard chat. A Python [ADK 2.0](https://adk.dev/2.0/)
`LlmAgent` deployed to the **Gemini Enterprise Agent Platform / Agent Runtime**
as a `reasoningEngine`, with managed **Sessions**, **Memory Bank**, and **Agent
Identity**. The Next.js app talks to it through a same-origin streaming proxy
(`src/app/api/admin/agent/chat`), never directly from the browser.

## How context flows
Vertex `:streamQuery` rejects unknown root-level request fields, so the proxy
smuggles tenant/user context and the reasoning mode as **message prefixes**:

```
[ctx:{"tenantId":"...","userId":"...","region":"...","traceId":"..."}] [mode:thinking] <user text>
```

`before_model_callback` runs two callbacks in order, both stripping their prefix
before Gemini sees the text:
1. `callbacks/context_envelope.py` → writes `tenantId/userId/region/traceId` into session `state`.
2. `callbacks/chat_mode.py` → sets `thinking_config` (fast = budget 0, thinking = dynamic).

Memory Bank is scoped per-tenant-per-user by the composite `user_id`
(`{tenantId}_{userId}`) the proxy sends — see `context/memory_config.py`.

## Layout
```
agent.py                     root LlmAgent (instruction + 2 callbacks; no tools yet)
__init__.py                  exposes root_agent for `adk deploy`
callbacks/context_envelope.py  [ctx:] envelope → session state (ported verbatim)
callbacks/chat_mode.py         [mode:] directive → thinking_config (ported)
context/brand_context.py       build_dynamic_instruction (state-based; Firestore reads = Phase 3)
context/memory_config.py       composite_user_id + optional VertexAiMemoryBankService
prompts/                       base system instruction
agent_logging/logger.py        structured logging
tests/                         pure-helper unit tests (no ADK needed)
.agent_engine_config.json      identity_type=AGENT_IDENTITY + runtime env_vars
deploy.sh                      wraps `adk deploy agent_engine`
```

Phase 3 adds `tools/` (marketing FunctionTools + A2A) and `subagents/`; Phase 4
adds MCP toolsets and memory search.

## Local test
The callbacks keep ADK imports under `TYPE_CHECKING`, so the pure helpers are
unit-testable without ADK installed (ADK 2.x needs Python 3.10+):

```bash
cd agents/root_agent
python -m pytest tests/ -v
```

The agent itself (`agent.py`) imports `google.adk` and only runs under ADK 2.x +
Python 3.10+ — exercise it via `adk web` or after deploy.

> The package directory name becomes the ADK **app name**, which must be a valid
> Python identifier (letters/digits/underscores) — hence `root_agent`, not
> `root-agent-py`. A hyphenated dir deploys fine but fails at query time with
> "Invalid agent name".

## Deploy
Build the deploy venv **outside** this package (at `agents/.venv`): `adk deploy`
uploads the whole package dir, and an in-package `.venv` blows the 8 MB payload
limit.

```bash
# one-time
python3.13 -m venv agents/.venv
agents/.venv/bin/pip install "google-adk[a2a]==2.2.0"   # match requirements.txt
gcloud auth application-default login                    # ADC — the deploy uses it

# deploy (no staging bucket — --staging_bucket is deprecated in adk 2.2)
cd agents/root_agent
../.venv/bin/python ../.venv/bin/adk deploy agent_engine \
  --project=vizzybl-marketing-dev --region=us-central1 \
  --display_name=vizzybl-marketing-root .
```
Identity (`AGENT_IDENTITY`) + runtime env come from `.agent_engine_config.json`.
Copy the returned `reasoningEngines/<ID>` tail into `ROOT_AGENT_RESOURCE_ID`
(apphosting.yaml, RUNTIME) and redeploy the Next.js app. The query endpoint needs
~1–2 min to warm up after "Deployed" (transient 404 until then).

**requirements.txt gotchas** (each cost a failed deploy):
- Pin `google-adk` EXACTLY to the local `adk --version` — the container launcher
  invokes `adk api_server` with version-specific flags (`--gemini_enterprise_app_name`).
- Use the **`[a2a]`** extra — Agent Runtime's launcher imports the `a2a` SDK at startup.
- Do NOT pin `google-genai`/`aiplatform` — adk owns those ranges (a stale
  `google-genai<2` pin conflicts with adk 2.2 → ResolutionImpossible build failure).

## IAM (least-privilege — see PRD §4)
- **App Hosting runtime SA** (`firebase-app-hosting-compute@<project>…`) — the
  *caller* — has the custom role **`reasoningEngineInvoker`** (only
  `aiplatform.reasoningEngines.query` + `.get`), NOT the broad `roles/aiplatform.user`.
- The agent runs under its own **Agent Identity** (keyless SPIFFE principal
  `…system.id.goog/resources/aiplatform/…/reasoningEngines/<ID>`) — the
  PRD-preferred per-agent identity. It gets Firestore-read / downstream-invoke
  grants in Phase 3 when tools land. The yougrow.ai org blocks external/Google-SA
  grants; use the temporary project-policy override if a grant is refused.
