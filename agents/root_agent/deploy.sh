#!/usr/bin/env bash
# Deploy the Vizzybl Marketing root agent to the Gemini Enterprise Agent Platform
# (Agent Runtime) as a reasoningEngine, with a managed Agent Identity. Reads
# identity_type + env_vars from .agent_engine_config.json. Prints the
# reasoningEngine resource ID on success — set its numeric tail as
# ROOT_AGENT_RESOURCE_ID in apphosting.yaml (RUNTIME).
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/../.venv"
if [ -x "$VENV/bin/python" ]; then
  ADK=("$VENV/bin/python" "$VENV/bin/adk")   # bypass the venv's hardcoded shebang
else
  ADK=(adk)
fi

echo "Deploying root agent: project=$PROJECT region=$REGION display=$DISPLAY_NAME identity=AGENT_IDENTITY"
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
