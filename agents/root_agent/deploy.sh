#!/usr/bin/env bash
# Deploy Vizzy, the YouGrow root agent, to Agent Runtime (a Vertex AI
# reasoningEngine) in your Google Cloud project, running as its own service
# account. Renders .agent_engine_config.json (generated, not committed), then runs
# `adk deploy agent_engine`. With AGENT_ENGINE_ID set it passes
# --agent_engine_id, so the deploy UPDATES that engine in place (a new revision in
# source mode) instead of creating a new one. (adk 2.2's CLI supports pinning via
# --agent_engine_id: it calls agent_engines.update(name=.../reasoningEngines/<id>).
# Don't switch to the Vertex SDK AdkApp path, which deploys in package_spec/pickle
# mode; the API refuses to update a source-mode engine across deployment modes.)
#
# Settings (environment variables; keep yours in a file and `source` it):
#   PROJECT                required. Your Google Cloud project id.
#   CANVAS_CALLBACK_URL    required. Your app's https origin, e.g. https://app.example.com.
#                          The agent's tools call it back (POST <url>/api/agent/...).
#   AGENT_ENGINE_ID        optional. The engine to update in place (the number at the end
#                          of .../reasoningEngines/<id>; the same as ROOT_AGENT_RESOURCE_ID
#                          in your apphosting.<env>.yaml). Unset: a NEW engine is created
#                          and its id printed, to put in your settings for next time.
#   REGION                 optional, default us-central1. Where the engine runs.
#   DISPLAY_NAME           optional, default yougrow-root.
#   AGENT_SERVICE_ACCOUNT  optional, default root-agent@$PROJECT.iam.gserviceaccount.com.
#                          infra/agent/setup.sh creates it with the roles it needs.
#   ROOT_AGENT_MODEL       optional, default gemini-3.6-flash (keep in step with
#                          DEFAULT_MODEL in model_config.py unless pinning on purpose).
#
# Usage:
#   PROJECT=my-project CANVAS_CALLBACK_URL=https://app.example.com bash agents/root_agent/deploy.sh --dry-run
#   set -a; . ./agent.env; set +a; bash agents/root_agent/deploy.sh
#
#   --dry-run   print the engine config and the exact deploy command, then exit.
#               Nothing is written or deployed.
#
# Prereqs (one time):
#   python3.12 -m venv agents/.venv                           # the venv lives OUTSIDE the package
#   agents/.venv/bin/pip install -r agents/requirements-deploy.txt
#   gcloud auth application-default login                     # the deploy uses ADC
#   bash infra/agent/setup.sh all <project>                   # service account + roles
#
# Notes:
#   - The package dir name (root_agent) becomes the ADK app name and MUST be a
#     valid Python identifier (no hyphens).
#   - The query endpoint warms up about 1 to 2 minutes after the deploy completes
#     (a 404 until then).
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

PROJECT="${PROJECT:-}"
REGION="${REGION:-us-central1}"
DISPLAY_NAME="${DISPLAY_NAME:-yougrow-root}"
CANVAS_CALLBACK_URL="${CANVAS_CALLBACK_URL:-}"
AGENT_ENGINE_ID="${AGENT_ENGINE_ID:-}"
ROOT_AGENT_MODEL="${ROOT_AGENT_MODEL:-gemini-3.6-flash}"

fail() { echo "$1" >&2; exit 2; }

# Validate every value before it is interpolated into the JSON config below: a
# value with a quote or newline would otherwise inject malformed JSON.
[ -n "$PROJECT" ] || fail "Set PROJECT to your Google Cloud project id, e.g. PROJECT=my-project bash $0 --dry-run"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "Refusing to deploy: invalid Google Cloud project id '$PROJECT'"
[ -n "$CANVAS_CALLBACK_URL" ] || fail "Set CANVAS_CALLBACK_URL to your app's https origin, e.g. CANVAS_CALLBACK_URL=https://app.example.com"
CANVAS_CALLBACK_URL="${CANVAS_CALLBACK_URL%/}"
[[ "$CANVAS_CALLBACK_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || fail "CANVAS_CALLBACK_URL must be an https origin with no path (got '$CANVAS_CALLBACK_URL')"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || fail "REGION must be a Google Cloud region, e.g. us-central1 (got '$REGION')"
[[ "$DISPLAY_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.\ -]{0,62}$ ]] || fail "DISPLAY_NAME may use letters, digits, spaces, dots, dashes and underscores (got '$DISPLAY_NAME')"
[ -z "$AGENT_ENGINE_ID" ] || [[ "$AGENT_ENGINE_ID" =~ ^[0-9]{1,30}$ ]] || fail "AGENT_ENGINE_ID must be the number at the end of .../reasoningEngines/<id> (got '$AGENT_ENGINE_ID')"
[[ "$ROOT_AGENT_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] || fail "ROOT_AGENT_MODEL must be a model id (got '$ROOT_AGENT_MODEL')"
SA="${AGENT_SERVICE_ACCOUNT:-root-agent@${PROJECT}.iam.gserviceaccount.com}"
[[ "$SA" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] || fail "AGENT_SERVICE_ACCOUNT must be a service account email (got '$SA')"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/../.venv"
if [ -x "$VENV/bin/python" ]; then
  ADK=("$VENV/bin/python" "$VENV/bin/adk")   # run adk via the venv python (its own shebang is stale)
elif [ -d "$VENV" ] && [ "$DRY_RUN" = "0" ]; then
  # A venv copied from another path, or whose Python was uninstalled, has no
  # interpreter: say so instead of silently using whatever adk is on PATH.
  echo "agents/.venv has no working Python. Recreate it:" >&2
  echo "  rm -rf agents/.venv && python3.12 -m venv agents/.venv && agents/.venv/bin/pip install -r agents/requirements-deploy.txt" >&2
  exit 1
else
  ADK=(adk)
fi

# The engine config: the agent runs as its own service account. Agent Runtime
# REJECTS env vars with an empty value ("Required field is not set"), so every
# value here is non-empty.
#   AGENT_PROJECT_ID: inside Agent Runtime, GOOGLE_CLOUD_PROJECT is the project
#   NUMBER; _project_fix.py swaps in this id before google-auth reads it.
#   ROOT_AGENT_MODEL: the deploy-time model for the ADK agents; wins at runtime.
CONFIG="$(cat <<EOF
{
  "identity_type": "SERVICE_ACCOUNT",
  "service_account": "${SA}",
  "env_vars": {
    "GOOGLE_GENAI_USE_VERTEXAI": "1",
    "GOOGLE_CLOUD_LOCATION": "global",
    "ROOT_AGENT_MODEL": "${ROOT_AGENT_MODEL}",
    "CANVAS_CALLBACK_URL": "${CANVAS_CALLBACK_URL}",
    "AGENT_PROJECT_ID": "${PROJECT}"
  }
}
EOF
)"

# --agent_engine_id pins the target: set => UPDATE that engine in place; unset
# => the CLI creates a new one. Built as a bash array so the flag is omitted
# entirely (not passed empty) when creating.
PIN_FLAG=()
if [ -n "$AGENT_ENGINE_ID" ]; then
  PIN_FLAG=(--agent_engine_id="$AGENT_ENGINE_ID")
fi
CMD=("${ADK[@]}" deploy agent_engine
  --project="$PROJECT"
  --region="$REGION"
  --display_name="$DISPLAY_NAME")
# Guard the expansion: macOS bash 3.2 with `set -u` treats an empty array as unbound.
if [ ${#PIN_FLAG[@]} -gt 0 ]; then
  CMD+=("${PIN_FLAG[@]}")
fi
CMD+=("$SCRIPT_DIR")

if [ -n "$AGENT_ENGINE_ID" ]; then
  echo "Deploying root agent (UPDATE id=$AGENT_ENGINE_ID): project=$PROJECT region=$REGION display=$DISPLAY_NAME sa=$SA"
else
  echo "Deploying root agent (CREATE new engine): project=$PROJECT region=$REGION display=$DISPLAY_NAME sa=$SA"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "Dry run: nothing written or deployed."
  echo "$SCRIPT_DIR/.agent_engine_config.json would be:"
  echo "$CONFIG"
  echo "Command:"
  printf '%q ' "${CMD[@]}"
  echo
  exit 0
fi

printf '%s\n' "$CONFIG" > "$SCRIPT_DIR/.agent_engine_config.json"
echo

# adk prints "Deploy failed: ..." but still exits 0, so check what it printed.
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "$DEPLOY_LOG"' EXIT
"${CMD[@]}" 2>&1 | tee "$DEPLOY_LOG"

echo
if ! grep -q "Deployed to Agent Platform" "$DEPLOY_LOG"; then
  echo "Deploy FAILED (see the output above): the engine was not updated." >&2
  exit 1
fi
if [ -z "$AGENT_ENGINE_ID" ]; then
  NEW_ID="$(grep -oE 'reasoningEngines/[0-9]+' "$DEPLOY_LOG" | tail -n 1 | cut -d/ -f2 || true)"
  if [ -n "$NEW_ID" ]; then
    echo "NEW engine created. Put its id in your settings so the next deploy updates it in place:"
    echo "  AGENT_ENGINE_ID=$NEW_ID              (for this script)"
    echo "  ROOT_AGENT_RESOURCE_ID: \"$NEW_ID\"   (apphosting.<env>.yaml, then roll out the app)"
  else
    echo "NEW engine created. Copy the reasoningEngines/<ID> tail above into AGENT_ENGINE_ID"
    echo "(for this script) and ROOT_AGENT_RESOURCE_ID (apphosting.<env>.yaml)."
  fi
fi
echo "The App Hosting runtime service account needs the reasoningEngineInvoker custom role"
echo "(aiplatform.reasoningEngines.query + .get) to call :streamQuery. infra/agent/setup.sh grants it."
