#!/usr/bin/env bash
# Deploy the YouGrow.ai root agent ("Vizzy") to the Gemini Enterprise Agent
# Platform (Agent Runtime) as a reasoningEngine, under a dedicated per-project
# service-account identity (root-agent@$PROJECT). This script RENDERS
# .agent_engine_config.json for $PROJECT, then runs `adk deploy agent_engine`
# with --agent_engine_id="$RESOURCE_ID" so redeploys REUSE the same engine id
# (in source/Dockerfile mode, as a new revision) instead of minting a new engine
# every time. (adk 2.2's CLI DOES support pinning via --agent_engine_id — it
# calls agent_engines.update(name=.../reasoningEngines/<id>); don't switch to the
# Vertex SDK AdkApp path, which deploys in package_spec/pickle mode and the API
# refuses to update a source-mode engine across deployment modes.) dev and prod
# each run under their own SA from a single command.
#
# Prereqs (one-time):
#   python3.13 -m venv ../.venv                          # venv OUTSIDE the package
#   ../.venv/bin/pip install "google-adk[a2a]==2.2.0"    # match requirements.txt
#   gcloud auth application-default login                 # ADC — the deploy uses it
#
# Notes:
#   - The package dir name (root_agent) becomes the ADK app name and MUST be a
#     valid Python identifier (no hyphens).
#   - The query endpoint warms up ~1-2 min after deploy completes (transient 404).
#
# Usage:
#   ./deploy.sh                                            # dev: UPDATE the pinned engine
#   ROOT_AGENT_PROJECT=vizzybl-marketing-prod ./deploy.sh  # prod: UPDATE the pinned engine
#   FORCE_CREATE=1 ./deploy.sh                             # mint a brand-new engine
#   ROOT_AGENT_RESOURCE_ID=123... ./deploy.sh              # override which id to update
set -euo pipefail

PROJECT="${ROOT_AGENT_PROJECT:-vizzybl-marketing-dev}"
REGION="${ROOT_AGENT_LOCATION:-us-central1}"
DISPLAY_NAME="${ROOT_AGENT_DISPLAY_NAME:-vizzybl-marketing-root}"

# Validate the project id before it is interpolated into the JSON config below —
# a value with a quote/newline would otherwise inject malformed JSON. Match GCP
# project-id rules (6-30 chars, lowercase letter first, letters/digits/hyphens).
if ! [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Refusing to deploy: invalid GCP project id '$PROJECT'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/../.venv"
if [ -x "$VENV/bin/python" ]; then
  ADK=("$VENV/bin/python" "$VENV/bin/adk")   # run adk via the venv python (its own shebang is stale)
else
  ADK=(adk)
fi

# Resolve which engine to UPDATE (--agent_engine_id). Source of truth is
# ROOT_AGENT_RESOURCE_ID in apphosting{,.prod}.yaml — pass it in, or fall back to
# the per-project pinned id below. FORCE_CREATE=1 skips the pin and mints a new
# engine (then copy its id back into apphosting + this case block).
if [ "${FORCE_CREATE:-0}" = "1" ]; then
  RESOURCE_ID=""
elif [ -n "${ROOT_AGENT_RESOURCE_ID:-}" ]; then
  RESOURCE_ID="$ROOT_AGENT_RESOURCE_ID"
else
  case "$PROJECT" in
    # MUST match ROOT_AGENT_RESOURCE_ID in apphosting{,.prod}.yaml (the engine the
    # app actually calls). prod's old 5390059436788154368 engine is ORPHANED.
    vizzybl-marketing-prod) RESOURCE_ID="4483147061826420736" ;;
    vizzybl-marketing-dev)  RESOURCE_ID="2597757299074269184" ;;
    *) RESOURCE_ID="" ;;
  esac
fi

# The app origin the Campaign Ops sub-agent calls back to (POST
# <url>/api/agent/canvas) to save journey drafts. Per-project default; override
# with CANVAS_CALLBACK_URL=... ./deploy.sh. Empty is allowed — the build_journey
# tool degrades to "authoring unavailable" until it's set (e.g. for dev, set it
# to the dev App Hosting origin).
if [ -z "${CANVAS_CALLBACK_URL:-}" ]; then
  case "$PROJECT" in
    vizzybl-marketing-prod) CANVAS_CALLBACK_URL="https://yougrow.ai" ;;
    *) CANVAS_CALLBACK_URL="" ;;
  esac
fi

# Render the engine config for THIS project: the SA email is deterministic per
# project, so dev and prod each deploy under their own dedicated identity. The
# committed file is the dev-rendered output (regenerating it for dev is a no-op).
SA="root-agent@${PROJECT}.iam.gserviceaccount.com"
# Agent Runtime REJECTS env vars with an empty value ("Required field is not
# set"), so only emit CANVAS_CALLBACK_URL when it's set (e.g. prod). The agent
# reads it with os.environ.get(...), so an absent key behaves like empty.
CANVAS_ENTRY=""
if [ -n "$CANVAS_CALLBACK_URL" ]; then
  CANVAS_ENTRY=",
    \"CANVAS_CALLBACK_URL\": \"${CANVAS_CALLBACK_URL}\""
fi
cat > "$SCRIPT_DIR/.agent_engine_config.json" <<EOF
{
  "identity_type": "SERVICE_ACCOUNT",
  "service_account": "${SA}",
  "env_vars": {
    "GOOGLE_GENAI_USE_VERTEXAI": "1",
    "GOOGLE_CLOUD_LOCATION": "global",
    "ROOT_AGENT_MODEL": "gemini-3.5-flash"${CANVAS_ENTRY}
  }
}
EOF

# --agent_engine_id pins the target: set => UPDATE that engine in place; unset
# => the CLI creates a new one. Built as a bash array so the flag is omitted
# entirely (not passed empty) when creating.
PIN_FLAG=()
if [ -n "$RESOURCE_ID" ]; then
  PIN_FLAG=(--agent_engine_id="$RESOURCE_ID")
  echo "Deploying root agent (UPDATE id=$RESOURCE_ID): project=$PROJECT region=$REGION display=$DISPLAY_NAME sa=$SA"
else
  echo "Deploying root agent (CREATE new engine): project=$PROJECT region=$REGION display=$DISPLAY_NAME sa=$SA"
fi
echo

"${ADK[@]}" deploy agent_engine \
  --project="$PROJECT" \
  --region="$REGION" \
  --display_name="$DISPLAY_NAME" \
  "${PIN_FLAG[@]}" \
  "$SCRIPT_DIR"

echo
if [ -z "$RESOURCE_ID" ]; then
  echo "NEW engine created. Copy the reasoningEngines/<ID> tail above into"
  echo "ROOT_AGENT_RESOURCE_ID (apphosting{,.prod}.yaml) AND this script's per-project"
  echo "case block so future redeploys update it in place."
fi
echo "Ensure the App Hosting runtime SA has the reasoningEngineInvoker custom role"
echo "(aiplatform.reasoningEngines.query + .get) so the proxy can call :streamQuery"
echo "(see README.md § IAM)."
