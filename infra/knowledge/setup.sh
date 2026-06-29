#!/usr/bin/env bash
#
# Provision the Knowledge Ingestion & Vector Retrieval (RAG) GCP side. See
# memory feature-knowledge-rag-ingestion, workers/knowledge-scraper/README.md,
# and src/lib/agents/knowledgeRetrieval.ts. The app ships OFF by default
# (KNOWLEDGE_RAG_ENABLED="false"); this provisions the infra, then you flip the
# flag. Least-privilege: the worker runs as a DEDICATED service account (NOT the
# default compute SA), and the App Hosting SA can only trigger the one job.
#
# Identities:
#   knowledge-scraper@<project>          -> the Cloud Run Job RUNTIME SA (container)
#       roles/datastore.user + knowledgeScraperPredict (aiplatform.endpoints.predict)
#       + roles/logging.logWriter
#   firebase-app-hosting-compute@<project> -> the TRIGGER (the Next.js ingest route)
#       knowledgeJobInvoker (run.jobs.runWithOverrides + get) bound ON THE JOB
#
# Usage (run in ORDER; DEV first, validate, THEN prod):
#   ./setup.sh sa      <project>   # create the dedicated runtime SA (idempotent)
#   ./setup.sh roles   <project>   # create/update the 2 custom roles
#   ./setup.sh iam     <project>   # bind runtime-SA roles + deployer actAs on the SA
#   ./setup.sh job     <project>   # build+deploy the Job as the SA, then bind the trigger role
#   ./setup.sh secrets <project>   # grant the SA secretAccessor on git-token-* (private repos; optional)
#   ./setup.sh index   <project>   # firebase deploy --only firestore:indexes (vector + composite, all DBs)
#   ./setup.sh verify  <project>   # show SA roles / job SA / job IAM / vector-index state
#   ./setup.sh all     <project>   # sa -> roles -> iam -> job -> secrets -> index -> verify
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# Stays MANUAL (config lives in git, not gcloud): set KNOWLEDGE_JOB_NAME in
# apphosting.<env>.yaml; create the git-token-* secret VALUES; and after content
# is ingested + the index is READY, flip KNOWLEDGE_RAG_ENABLED="true" and deploy.
#
# Requires: gcloud, firebase CLI, python3, git. First-party in-project SA grants
# are NOT blocked by the org domain-restricted-sharing policy, so no override.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"

JOB_NAME="knowledge-scraper"
JOB_REGION="us-central1"
JOB_SA="knowledge-scraper@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"
INVOKER_ROLE="knowledgeJobInvoker"
PREDICT_ROLE="knowledgeScraperPredict"

# The identity running this script needs actAs on JOB_SA to attach it to the job.
DEPLOYER="$(gcloud config get-value account 2>/dev/null || true)"
case "${DEPLOYER}" in
  *gserviceaccount.com) DEPLOYER_MEMBER="serviceAccount:${DEPLOYER}" ;;
  "")                   DEPLOYER_MEMBER="" ;;
  *)                    DEPLOYER_MEMBER="user:${DEPLOYER}" ;;
esac

# ----------------------------------------------------------------------------

sa() {
  echo "==> Dedicated runtime SA ${JOB_SA}"
  if gcloud iam service-accounts describe "${JOB_SA}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "    exists — skipping"
  else
    gcloud iam service-accounts create "${JOB_NAME}" --project="${PROJECT}" \
      --display-name="Knowledge scraper job runtime" >/dev/null
    echo "    created"
  fi
}

ensure_role() { # <id> <title> <permissions>
  if gcloud iam roles describe "$1" --project="${PROJECT}" >/dev/null 2>&1; then
    # Keep permissions in sync; tolerate "no changes".
    gcloud iam roles update "$1" --project="${PROJECT}" --permissions="$3" >/dev/null 2>&1 || true
    echo "    role $1 exists — permissions synced"
  else
    gcloud iam roles create "$1" --project="${PROJECT}" --title="$2" \
      --permissions="$3" --stage=GA >/dev/null
    echo "    created role $1"
  fi
}

roles() {
  echo "==> Custom roles in ${PROJECT}"
  ensure_role "${INVOKER_ROLE}" "Knowledge Job Invoker" "run.jobs.runWithOverrides,run.jobs.get"
  ensure_role "${PREDICT_ROLE}" "Knowledge Scraper Predict" "aiplatform.endpoints.predict"
}

iam() {
  echo "==> Runtime SA (${JOB_SA}) least-privilege roles"
  for r in "roles/datastore.user" "roles/logging.logWriter" "projects/${PROJECT}/roles/${PREDICT_ROLE}"; do
    gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${JOB_SA}" --role="${r}" --condition=None >/dev/null
    echo "    + ${r}"
  done
  if [ -n "${DEPLOYER_MEMBER}" ]; then
    echo "==> Let the deployer (${DEPLOYER}) attach the SA to the job (actAs)"
    gcloud iam service-accounts add-iam-policy-binding "${JOB_SA}" --project="${PROJECT}" \
      --member="${DEPLOYER_MEMBER}" --role="roles/iam.serviceAccountUser" >/dev/null
    echo "    + serviceAccountUser for ${DEPLOYER}"
  else
    echo "    ⚠️  no active gcloud account — skipped actAs grant (grant serviceAccountUser on ${JOB_SA} manually)"
  fi
}

job() {
  echo "==> Building + deploying the Cloud Run Job as ${JOB_SA}"
  JOB_SA="${JOB_SA}" PROJECT="${PROJECT}" REGION="${JOB_REGION}" JOB_NAME="${JOB_NAME}" \
    bash "${ROOT}/workers/knowledge-scraper/deploy.sh"
  echo "==> Binding ${INVOKER_ROLE} to ${RUNTIME_SA} ON THE JOB (the trigger permission)"
  gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region="${JOB_REGION}" --project="${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="projects/${PROJECT}/roles/${INVOKER_ROLE}" >/dev/null
  echo "    + ${INVOKER_ROLE} on job ${JOB_NAME}"
}

secrets() {
  echo "==> git-token-* secretAccessor for the runtime SA (private repos only)"
  for s in git-token-github git-token-gitlab; do
    if gcloud secrets describe "${s}" --project="${PROJECT}" >/dev/null 2>&1; then
      gcloud secrets add-iam-policy-binding "${s}" --project="${PROJECT}" \
        --member="serviceAccount:${JOB_SA}" \
        --role="roles/secretmanager.secretAccessor" >/dev/null
      echo "    + secretAccessor on ${s}"
    else
      echo "    ${s} not present — skipping (create it only if ingesting private repos)"
    fi
  done
}

index() {
  echo "==> Deploying Firestore indexes (knowledge_bases COLLECTION vector + ingestion_tickets composite, all DBs)"
  ( cd "${ROOT}" && firebase deploy --only firestore:indexes --project="${PROJECT}" --non-interactive )
}

verify() {
  echo "==> Runtime SA (${JOB_SA}) project roles"
  gcloud projects get-iam-policy "${PROJECT}" --flatten="bindings[].members" \
    --filter="bindings.members:serviceAccount:${JOB_SA}" \
    --format="value(bindings.role)" 2>/dev/null || true
  echo "==> Job runtime SA"
  gcloud run jobs describe "${JOB_NAME}" --region="${JOB_REGION}" --project="${PROJECT}" \
    --format=export 2>/dev/null | grep -i serviceaccountname || echo "    (job not deployed)"
  echo "==> Job IAM policy (want ${INVOKER_ROLE} for ${RUNTIME_SA})"
  gcloud run jobs get-iam-policy "${JOB_NAME}" --region="${JOB_REGION}" --project="${PROJECT}" 2>/dev/null || true
  echo "==> knowledge_bases vector-index state per DB"
  for DB in "(default)" "signups-eu" "signups-asia"; do
    printf "    %-12s " "${DB}"
    gcloud firestore indexes composite list --database="${DB}" --project="${PROJECT}" --format=json 2>/dev/null \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((i.get('state') for i in d if '/collectionGroups/knowledge_bases/' in i.get('name','')),'NOT FOUND'))" 2>/dev/null \
      || echo "?"
  done
}

all() {
  sa
  roles
  iam
  job
  secrets
  index
  verify
  cat <<EOF

==> Provisioned ${PROJECT}. Remaining MANUAL steps:
  1. Set KNOWLEDGE_JOB_NAME=${JOB_NAME} in apphosting.<env>.yaml (and deploy the app).
  2. Once the vector index is READY and real content is ingested, flip
     KNOWLEDGE_RAG_ENABLED="true" and deploy.
EOF
}

case "${CMD}" in
  sa)      sa ;;
  roles)   roles ;;
  iam)     iam ;;
  job)     job ;;
  secrets) secrets ;;
  index)   index ;;
  verify)  verify ;;
  all)     all ;;
  *)       sed -n '2,33p' "$0" ;;
esac
