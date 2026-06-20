#!/usr/bin/env bash
# Deploy the YouGrow.ai root agent ("Vizzy") to the Gemini Enterprise Agent
# Platform (Agent Runtime) as a reasoningEngine, under a dedicated per-project
# service-account identity (root-agent@$PROJECT). This script RENDERS
# .agent_engine_config.json for $PROJECT before deploying, so dev and prod each
# run under their own SA from a single command. Prints the reasoningEngine
# resource ID on success — set its numeric tail as ROOT_AGENT_RESOURCE_ID in the
# matching apphosting{,.prod}.yaml (RUNTIME).
#
# Prereqs (one-time):
#   python3.13 -m venv ../.venv                          # venv OUTSIDE the package
#   ../.venv/bin/pip install "google-adk[a2a]==2.2.0"    # match requirements.txt
#   gcloud auth application-default login                 # ADC — the deploy uses it
#
# Notes:
#   - The package dir name (root_agent) becomes the ADK app name and MUST be a
#     valid Python identifier (no hyphens).
#   - No staging bucket needed (--staging_bucket is deprecated in adk 2.2).
#   - The query endpoint warms up ~1-2 min after "Deployed" (transient 404).
#
# Usage:
#   ./deploy.sh                                            # dev defaults
#   ROOT_AGENT_PROJECT=vizzybl-marketing-prod ./deploy.sh  # prod
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
  ADK=("$VENV/bin/python" "$VENV/bin/adk")   # bypass the venv's hardcoded shebang
else
  ADK=(adk)
fi

# Render the engine config for THIS project: the SA email is deterministic per
# project, so dev and prod each deploy under their own dedicated identity. The
# committed file is the dev-rendered output (regenerating it for dev is a no-op).
SA="root-agent@${PROJECT}.iam.gserviceaccount.com"
cat > "$SCRIPT_DIR/.agent_engine_config.json" <<EOF
{
  "identity_type": "SERVICE_ACCOUNT",
  "service_account": "${SA}",
  "env_vars": {
    "GOOGLE_GENAI_USE_VERTEXAI": "1",
    "GOOGLE_CLOUD_LOCATION": "global",
    "ROOT_AGENT_MODEL": "gemini-3.5-flash"
  }
}
EOF

echo "Deploying root agent: project=$PROJECT region=$REGION display=$DISPLAY_NAME identity=SERVICE_ACCOUNT sa=$SA"
echo

"${ADK[@]}" deploy agent_engine \
  --project="$PROJECT" \
  --region="$REGION" \
  --display_name="$DISPLAY_NAME" \
  "$SCRIPT_DIR"

echo
echo "Done. Copy the reasoningEngines/<ID> tail into ROOT_AGENT_RESOURCE_ID, and"
echo "ensure the App Hosting runtime SA has the reasoningEngineInvoker custom role"
echo "(aiplatform.reasoningEngines.query + .get) so the proxy can call :streamQuery"
echo "(see README.md § IAM)."
