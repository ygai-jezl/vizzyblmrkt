#!/usr/bin/env bash
# Build + deploy the knowledge-scraper Cloud Run Job.
#
# Usage:
#   PROJECT=vizzybl-marketing-dev bash workers/knowledge-scraper/deploy.sh
#   PROJECT=vizzybl-marketing-prod REGION=us-central1 bash workers/knowledge-scraper/deploy.sh
#
# Prereqs (one-time per project — see README.md "Provisioning"):
#   - Artifact Registry repo `knowledge-scraper` exists (created here if missing).
#   - A runtime SA with roles/datastore.user + roles/aiplatform.user (+ secret
#     accessor for the git tokens). Pass it as JOB_SA, else the default compute SA.
#   - The App Hosting runtime SA holds run.jobs.runWithOverrides on this job (so the
#     app can trigger it). Grant separately; not done here.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=vizzybl-marketing-dev|prod}"
REGION="${REGION:-us-central1}"
JOB_NAME="${JOB_NAME:-knowledge-scraper}"
REPO="${REPO:-knowledge-scraper}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${JOB_NAME}:latest"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Ensuring Artifact Registry repo ${REPO} in ${PROJECT}/${REGION}"
gcloud artifacts repositories describe "${REPO}" \
  --project="${PROJECT}" --location="${REGION}" >/dev/null 2>&1 || \
gcloud artifacts repositories create "${REPO}" \
  --project="${PROJECT}" --location="${REGION}" \
  --repository-format=docker --description="Knowledge scraper job images"

echo "==> Building + pushing image ${IMAGE}"
gcloud builds submit "${HERE}" --project="${PROJECT}" --tag="${IMAGE}"

# Secrets for private repo clones (optional). Wire them only if they exist.
SECRET_FLAGS=()
for pair in "GIT_TOKEN_GITHUB=git-token-github" "GIT_TOKEN_GITLAB=git-token-gitlab"; do
  env_name="${pair%%=*}"; secret_name="${pair##*=}"
  if gcloud secrets describe "${secret_name}" --project="${PROJECT}" >/dev/null 2>&1; then
    SECRET_FLAGS+=("--set-secrets=${env_name}=${secret_name}:latest")
  fi
done

DEPLOY_ARGS=(
  "${JOB_NAME}"
  --project="${PROJECT}"
  --region="${REGION}"
  --image="${IMAGE}"
  --task-timeout=900s
  --max-retries=1
  --cpu=1
  --memory=2Gi
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT}"
)
[[ -n "${JOB_SA:-}" ]] && DEPLOY_ARGS+=(--service-account="${JOB_SA}")
DEPLOY_ARGS+=("${SECRET_FLAGS[@]}")

echo "==> Deploying Cloud Run Job ${JOB_NAME}"
if gcloud run jobs describe "${JOB_NAME}" --project="${PROJECT}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${DEPLOY_ARGS[@]}"
else
  gcloud run jobs create "${DEPLOY_ARGS[@]}"
fi

echo "==> Done. Set KNOWLEDGE_JOB_NAME=${JOB_NAME} (+ KNOWLEDGE_JOB_LOCATION=${REGION}) in apphosting and flip KNOWLEDGE_RAG_ENABLED once the vector index is built."
