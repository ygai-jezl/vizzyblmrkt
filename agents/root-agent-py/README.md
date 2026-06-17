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
unit-testable without ADK installed (ADK 2.0 needs Python 3.10+):

```bash
cd agents/root-agent-py
python -m pytest tests/ -v          # or: python -m pytest
```

The agent itself (`agent.py`) imports `google.adk` and only runs under ADK 2.0 +
Python 3.10+ — exercise it end-to-end via `adk web` or after deploy.

## Deploy
```bash
pip install "google-adk>=2.0" "google-cloud-aiplatform[agent_engines,adk]>=1.112"
gcloud auth application-default login
gsutil mb -l us-central1 gs://vizzybl-marketing-dev-agent-staging   # one-time
./deploy.sh                                                         # dev
ROOT_AGENT_PROJECT=vizzybl-marketing-prod ./deploy.sh               # prod
```
Copy the returned `reasoningEngines/<ID>` tail into `ROOT_AGENT_RESOURCE_ID`
(apphosting.yaml, RUNTIME) and redeploy the Next.js app.

## IAM
- **App Hosting runtime SA** (`firebase-app-hosting-compute@<project>...`) needs
  `roles/aiplatform.user` so the proxy's ADC token can call `:streamQuery`.
- The agent's **Agent Identity** principal (`principal://…/reasoningEngines/<ID>`)
  needs Firestore read + downstream-invoke grants — added in Phase 3 when tools
  land. The yougrow.ai org blocks external/Google-SA grants; use the temporary
  project-policy override if a grant is refused.
