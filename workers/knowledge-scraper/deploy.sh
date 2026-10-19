#!/usr/bin/env bash
# Build + deploy the knowledge-scraper Cloud Run Job in your Google Cloud project.
#
# Usage:
#   PROJECT=my-project bash workers/knowledge-scraper/deploy.sh
#   PROJECT=my-project REGION=us-central1 bash workers/knowledge-scraper/deploy.sh
#   GITHUB_APP_ID=123456 PROJECT=my-project bash workers/knowledge-scraper/deploy.sh   # with the read-only GitHub App
#   SCRAPER_USER_AGENT="MyBot/1.0 (+https://example.com/bot)" PROJECT=my-project bash workers/knowledge-scraper/deploy.sh
#
# Settings (environment variables):
#   PROJECT             required. Your Google Cloud project id.
#   REGION              default us-central1. JOB_NAME and REPO default to knowledge-scraper.
#   JOB_SA              the job's runtime service account (infra/knowledge/setup.sh creates
#                       knowledge-scraper@<project>); unset uses the default compute SA.
#   GITHUB_APP_ID       the public id of your read-only GitHub App, when you have one.
#   SCRAPER_USER_AGENT  how the crawler names itself (unset: YouGrowBot/1.0). No commas.
#
# Prereqs (one time per project; see README.md "Provisioning"):
#   - Artifact Registry repo `knowledge-scraper` exists (created here if missing).
#   - A runtime SA with roles/datastore.user + roles/aiplatform.user (+ secret
#     accessor for the git tokens). Pass it as JOB_SA, else the default compute SA.
#   - The App Hosting runtime SA holds run.jobs.runWithOverrides on this job (so the
#     app can trigger it). Grant separately; not done here.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project id, e.g. PROJECT=my-project bash workers/knowledge-scraper/deploy.sh}"
SCRAPER_USER_AGENT="${SCRAPER_USER_AGENT:-}"
case "${SCRAPER_USER_AGENT}" in
  *,*) echo "SCRAPER_USER_AGENT can't contain a comma (gcloud --set-env-vars splits on commas)." >&2; exit 2 ;;
esac
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
# github-app-private-key: signs one-hour, read-only installation tokens for
# tenants connected through the YouGrow GitHub App (pass GITHUB_APP_ID too).
# GIT_TOKEN_ENC_KEY decrypts per-tenant OAuth tokens stored on the tenant doc
# (preferred path); GIT_TOKEN_GITHUB/GITLAB are the legacy static fallback.
SECRET_FLAGS=()
for pair in \
  "GIT_TOKEN_ENC_KEY=git-token-enc-key" \
  "GIT_TOKEN_GITHUB=git-token-github" \
  "GIT_TOKEN_GITLAB=git-token-gitlab" \
  "GITHUB_APP_PRIVATE_KEY=github-app-private-key"; do
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
  --task-timeout=3600s
  --max-retries=1
  --cpu=2
  --memory=4Gi
  # The GitHub App id is public; set it with GITHUB_APP_ID=... when the app exists.
  # SCRAPER_USER_AGENT names your deployment to the sites the crawler reads.
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT}${GITHUB_APP_ID:+,GITHUB_APP_ID=${GITHUB_APP_ID}}${SCRAPER_USER_AGENT:+,SCRAPER_USER_AGENT=${SCRAPER_USER_AGENT}}"
)
[[ -n "${JOB_SA:-}" ]] && DEPLOY_ARGS+=(--service-account="${JOB_SA}")
# Guard the array expansion: under macOS bash 3.2 + `set -u`, "${EMPTY[@]}"
# throws "unbound variable" and would abort before the job is ever created.
if [ ${#SECRET_FLAGS[@]} -gt 0 ]; then
  DEPLOY_ARGS+=("${SECRET_FLAGS[@]}")
fi

echo "==> Deploying Cloud Run Job ${JOB_NAME}"
if gcloud run jobs describe "${JOB_NAME}" --project="${PROJECT}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update "${DEPLOY_ARGS[@]}"
else
  gcloud run jobs create "${DEPLOY_ARGS[@]}"
fi

echo "==> Done. Set KNOWLEDGE_JOB_NAME=${JOB_NAME} (+ KNOWLEDGE_JOB_LOCATION=${REGION}) in apphosting and flip KNOWLEDGE_RAG_ENABLED once the vector index is built."
