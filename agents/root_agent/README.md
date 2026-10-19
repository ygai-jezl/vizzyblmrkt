# Vizzy: the root agent (ADK 2.x)

The backend for the dashboard chat. A Python [ADK 2.x](https://adk.dev/2.0/)
`LlmAgent` deployed to the **Gemini Enterprise Agent Platform (Agent Runtime)**
as a `reasoningEngine`, with managed **Sessions** and **Memory Bank**. The
Next.js app talks to it through a same-origin streaming proxy
(`src/app/api/admin/agent/chat`), never directly from the browser.

## How context flows
Vertex `:streamQuery` rejects unknown root-level request fields, so the proxy
passes tenant/user context and the reasoning mode as **message prefixes**:

```
[ctx:{"tenantId":"...","userId":"...","region":"...","traceId":"...","ctxToken":"..."}] [mode:thinking] <user text>
```

`before_model_callback` runs two callbacks in order, both stripping their prefix
before Gemini sees the text:
1. `callbacks/context_envelope.py` writes the envelope keys into session `state`.
2. `callbacks/chat_mode.py` sets `thinking_config` (fast = budget 0, thinking = dynamic).

Memory Bank is scoped per tenant per user by the composite `user_id`
(`{tenantId}_{userId}`) the proxy sends (see `context/memory_config.py`).

## Tools and sub-agents
The agent never reads Firestore itself. Every tool calls back to the app over
HTTPS (`$CANVAS_CALLBACK_URL/api/agent/*`) with `ctxToken`, a short-lived token
the proxy signs with `CANVAS_CONTEXT_SIGNING_KEY`. The app verifies it and takes
the tenant from the token, never from the request body. Anything the agent
writes is a draft or a suggestion that a person accepts in the app.

- **Root tools:** knowledge search, Insights summary, Email style, journey
  style, brand map, brand notes ("What we've seen"), setup status and help pages.
- **Sub-agents:** `campaign_ops` (launch journeys and invite waves),
  `lifecycle_ops` (product lifecycle journeys, learning a product from its repo,
  one person's plan) and `content_ops` (content plans).

Each tool keeps its request logic in a pure `*_client.py` module with a thin ADK
wrapper beside it. If the app has the matching feature switched off, the tool
answers with a plain "not switched on" message.

## Layout
```
agent.py              root LlmAgent: instruction, 2 callbacks, tools, sub-agents
__init__.py           exposes root_agent for `adk deploy`
_project_fix.py       maps the runtime's project number to a project id (ADK bug workaround)
model_config.py       DEFAULT_MODEL (overridden by ROOT_AGENT_MODEL)
callbacks/            [ctx:] envelope and [mode:] directive
context/              dynamic instruction, language, Memory Bank scoping
prompts/              base system instruction
tools/                root FunctionTools (pure *_client.py + ADK wrappers)
sub_agents/           campaign_ops, lifecycle_ops, content_ops (each with prompts/ and tools/)
agent_logging/        structured logging
tests/                unit tests (pure clients; the tool declaration tests need ADK)
deploy.sh             renders .agent_engine_config.json, then runs `adk deploy agent_engine`
```

## Local test
The callbacks keep ADK imports under `TYPE_CHECKING`, so most logic is tested
without ADK. Tests that need ADK start with `pytest.importorskip("google.adk")`.
The package's `__init__.py` imports `agent.py`, so run the suite from a Python
3.10+ venv with ADK installed (the deploy venv plus pytest). CI doesn't run it.

```bash
agents/.venv/bin/pip install pytest     # once
cd agents/root_agent
../.venv/bin/python -m pytest tests/ -q
```

> The package directory name becomes the ADK **app name**, which must be a valid
> Python identifier. That is why it is `root_agent`, not `root-agent`: a
> hyphenated name deploys but fails at query time with "Invalid agent name".

## Deploy
Build the deploy venv **outside** this package (at `agents/.venv`). `adk deploy`
uploads the whole package directory, and an in-package `.venv` breaks the 8 MB
upload limit.

```bash
# one time
python3.12 -m venv agents/.venv
agents/.venv/bin/pip install -r agents/requirements-deploy.txt
gcloud auth application-default login

# first deploy creates a new engine
ROOT_AGENT_PROJECT=<your-project> \
CANVAS_CALLBACK_URL=https://<your-app-origin> \
  bash agents/root_agent/deploy.sh

# later deploys update that engine in place
ROOT_AGENT_PROJECT=<your-project> ROOT_AGENT_RESOURCE_ID=<engine-id> \
CANVAS_CALLBACK_URL=https://<your-app-origin> \
  bash agents/root_agent/deploy.sh
```

`deploy.sh` writes `.agent_engine_config.json` for the project: the agent runs as
the service account `root-agent@<project>.iam.gserviceaccount.com`
(`identity_type: SERVICE_ACCOUNT`), with `ROOT_AGENT_MODEL` and
`CANVAS_CALLBACK_URL` as runtime env. Create that service account first and let
it call Gemini on Vertex AI. Copy the `reasoningEngines/<ID>` tail the deploy
prints into `ROOT_AGENT_RESOURCE_ID` in your App Hosting config, then redeploy the
app. The query endpoint needs about 1 to 2 minutes to warm up after "Deployed"
(a 404 until then).

**requirements.txt gotchas:**
- Pin `google-adk` to exactly the local `adk --version`. The container launcher
  calls `adk api_server` with version-specific flags.
- Keep the **`[a2a]`** extra. Agent Runtime's launcher imports the `a2a` SDK at
  startup.
- Do not pin `google-genai` or `aiplatform`. ADK owns those ranges, and a stale
  pin makes the build fail with ResolutionImpossible.

## IAM (least privilege)
- **The caller** (the App Hosting runtime service account) needs only
  `aiplatform.reasoningEngines.query` and `.get`, for example through a custom
  role, rather than the broad `roles/aiplatform.user`.
- **The agent** runs as its own `root-agent@<project>` service account. It needs
  Vertex AI access for Gemini and nothing for app data, because it reaches app
  data only through the signed callback routes above.
