#!/usr/bin/env bash
#
# Provision the SCHEDULED email-delivery worker.
#
# The in-app journey/broadcast engine writes due sends into the Firestore
# `email_jobs` queue (see src/lib/email/delivery.ts). Something must drain that
# queue on a cadence — App Hosting has no built-in cron. This wires a Cloud
# Scheduler job that POSTs the worker endpoint, authenticated by a shared secret:
#
#   Cloud Scheduler --(POST + X-Worker-Secret)--> /api/admin/email/jobs/process
#                                                  -> processEmailJobsForAllTenants
#                                                     (drains EVERY tenant, all regions)
#
# The same secret is stored in Secret Manager (the app reads it as
# EMAIL_WORKER_SECRET via apphosting.prod.yaml) and set as the scheduler's
# request header, so only the scheduler can trigger the machine fan-out.
#
# Usage:
#   ./setup.sh secret    <project>   # create email-worker-secret + grant the runtime SA (REVERSIBLE)
#   ./setup.sh scheduler <project>   # create/refresh the Cloud Scheduler job (REVERSIBLE)
#   ./setup.sh verify    <project>   # show the secret binding + scheduler job + last run
#   ./setup.sh run       <project>   # trigger the job once now (smoke test)
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# Order of operations:
#   1) ./setup.sh secret  <project>     (create the secret)
#   2) uncomment EMAIL_WORKER_SECRET in apphosting.<env>.yaml + DEPLOY the app
#      (the secret must exist before the rollout references it)
#   3) ./setup.sh scheduler <project>   (start the cron)
#   4) ./setup.sh verify <project>      (confirm it runs and jobs drain)

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"

SECRET_NAME="email-worker-secret"
JOB_NAME="email-delivery-worker"
LOCATION="us-central1"          # Scheduler region. Triggers an HTTP call only — carries no
                               # PII, so it is NOT a data-residency boundary. Adjust if the
                               # gcp.resourceLocations org policy disallows this region.
SCHEDULE="*/2 * * * *"          # every 2 minutes (drip cadence; due jobs only)
RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"

# Target host: the canonical platform origin (NEXT_PUBLIC_PLATFORM_ORIGIN).
# The endpoint is host-agnostic for the secret (machine) caller — it fans out to
# every tenant regardless of which host it is reached on.
if [[ "${PROJECT}" == "vizzybl-marketing-prod" ]]; then
  TARGET_HOST="https://yougrow.ai"
else
  TARGET_HOST="https://yougrow-dev.web.app"   # placeholder; set to the dev backend URL
fi
URI="${TARGET_HOST}/api/admin/email/jobs/process"

secret() {
  echo "==> Provisioning Secret Manager secret '${SECRET_NAME}' in ${PROJECT}"

  if gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "    secret already exists — adding a new version"
  else
    echo "    creating secret (automatic replication)"
    gcloud secrets create "${SECRET_NAME}" --project="${PROJECT}" --replication-policy="automatic"
  fi

  echo "    generating a 256-bit random value and storing a new version"
  openssl rand -hex 32 | tr -d '\n' \
    | gcloud secrets versions add "${SECRET_NAME}" --project="${PROJECT}" --data-file=-

  echo "    granting the App Hosting runtime SA read access (secretAccessor)"
  # Same-org SA → not blocked by org-domain-restricted-sharing. App Hosting also
  # tracks the binding when you reference the secret in apphosting.<env>.yaml;
  # `firebase apphosting:secrets:grantaccess ${SECRET_NAME} --project ${PROJECT}`
  # is the firebase-native equivalent of this grant.
  gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"

  echo "==> Done. Uncomment EMAIL_WORKER_SECRET in apphosting.<env>.yaml, deploy, THEN run: ./setup.sh scheduler ${PROJECT}"
}

scheduler() {
  echo "==> Creating/refreshing Cloud Scheduler job '${JOB_NAME}' in ${PROJECT} (${LOCATION})"
  echo "    schedule='${SCHEDULE}'  ->  POST ${URI}"

  # Read the live secret value so the header matches what the app validates. The
  # value never appears in this script or shell history.
  local value
  value="$(gcloud secrets versions access latest --secret="${SECRET_NAME}" --project="${PROJECT}")"

  local action="create"
  if gcloud scheduler jobs describe "${JOB_NAME}" --project="${PROJECT}" --location="${LOCATION}" >/dev/null 2>&1; then
    action="update"
    echo "    job exists — updating"
  fi

  gcloud scheduler jobs "${action}" http "${JOB_NAME}" \
    --project="${PROJECT}" \
    --location="${LOCATION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="Etc/UTC" \
    --uri="${URI}" \
    --http-method=POST \
    --headers="X-Worker-Secret=${value}" \
    --attempt-deadline=120s \
    --max-retry-attempts=1

  echo "==> Done. Verify with: ./setup.sh verify ${PROJECT}"
}

verify() {
  echo "==> Secret IAM binding for '${SECRET_NAME}'"
  gcloud secrets get-iam-policy "${SECRET_NAME}" --project="${PROJECT}" \
    --format="yaml(bindings)" 2>/dev/null || echo "    (secret not found — run: ./setup.sh secret ${PROJECT})"

  echo "==> Scheduler job"
  gcloud scheduler jobs describe "${JOB_NAME}" --project="${PROJECT}" --location="${LOCATION}" \
    --format="yaml(name,schedule,state,httpTarget.uri,httpTarget.httpMethod,lastAttemptTime,status)" \
    2>/dev/null || echo "    (job not found — run: ./setup.sh scheduler ${PROJECT})"

  echo "==> Tip: confirm jobs are draining"
  echo "    In Firestore (each region DB) the email_jobs collection should show"
  echo "    journey_step docs moving pending -> done; past-dated 'pending' means stuck."
}

run() {
  echo "==> Triggering '${JOB_NAME}' once now"
  gcloud scheduler jobs run "${JOB_NAME}" --project="${PROJECT}" --location="${LOCATION}"
  echo "    Check the App Hosting logs for the [delivery] / response body."
}

case "${CMD}" in
  secret)    secret ;;
  scheduler) scheduler ;;
  verify)    verify ;;
  run)       run ;;
  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
