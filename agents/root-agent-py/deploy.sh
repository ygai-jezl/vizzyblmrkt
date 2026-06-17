#!/usr/bin/env bash
# Deploy the Vizzybl Marketing root agent to the Gemini Enterprise Agent Platform
# (Agent Runtime) as a reasoningEngine, with a managed Agent Identity.
#
# Reads identity_type + env_vars from .agent_engine_config.json. Prints the
# reasoningEngine resource ID on success — set its numeric tail as
# ROOT_AGENT_RESOURCE_ID in apphosting.yaml (RUNTIME).
#
# Prereqs (one-time):
#   pip install "google-adk>=2.0" "google-cloud-aiplatform[agent_engines,adk]>=1.112"
#   gcloud auth application-default login
#   gsutil mb -l "$REGION" "gs://${PROJECT}-agent-staging"   # staging bucket
#
# Usage:
#   ./deploy.sh                 # deploy to dev defaults
#   ROOT_AGENT_PROJECT=vizzybl-marketing-prod ./deploy.sh
set -euo pipefail

PROJECT="${ROOT_AGENT_PROJECT:-vizzybl-marketing-dev}"
REGION="${ROOT_AGENT_LOCATION:-us-central1}"
BUCKET="${ROOT_AGENT_STAGING_BUCKET:-gs://${PROJECT}-agent-staging}"
DISPLAY_NAME="${ROOT_AGENT_DISPLAY_NAME:-vizzybl-marketing-root}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Deploying root agent:"
echo "  project       = $PROJECT"
echo "  region        = $REGION"
echo "  staging bucket = $BUCKET"
echo "  display name  = $DISPLAY_NAME"
echo "  identity      = AGENT_IDENTITY (from .agent_engine_config.json)"
echo

adk deploy agent_engine \
  --project="$PROJECT" \
  --region="$REGION" \
  --staging_bucket="$BUCKET" \
  --display_name="$DISPLAY_NAME" \
  "$SCRIPT_DIR"

echo
echo "Done. Copy the reasoningEngines/<ID> tail into ROOT_AGENT_RESOURCE_ID,"
echo "and grant the App Hosting runtime SA roles/aiplatform.user so the proxy"
echo "can call :streamQuery (see README.md § IAM)."
