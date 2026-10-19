#!/usr/bin/env bash
#
# Provision the connected-product lifecycle feature (Products, connections,
# ingest API, sandbox) in one Google Cloud project.
#
#   ./setup.sh secret        <project>  # create connect-secret-enc-key + grant the backend (REVERSIBLE)
#   ./setup.sh worker-secret <project>  # create lifecycle-worker-secret + grant the backend (REVERSIBLE)
#   ./setup.sh signing-key   <project>  # create the KMS key that signs requests TO products + grant sign/view only
#   ./setup.sh rotate-signing-key <project>  # add a key version (published now, signs after 24 h)
#   ./setup.sh retire-signing-key <project> <version>  # disable an old version once the new one signs (REVERSIBLE: enable)
#   ./setup.sh ttl           <project>  # Firestore TTL policies on every database (REVERSIBLE)
#   ./setup.sh scheduler     <project>  # create/refresh the 2-minute lifecycle tick (REVERSIBLE; needs APP_URL)
#   ./setup.sh run           <project>  # trigger the tick once now (smoke test)
#   ./setup.sh verify        <project>  # show the secret bindings, TTL state and scheduler job
#
# Settings (environment variables):
#   APP_URL              your app's https origin, e.g. https://app.example.com. Needed by
#                        scheduler (the tick calls APP_URL/api/admin/lifecycle/tick); verify
#                        also checks APP_URL/.well-known/jwks.json when it is set.
#   BACKEND              the App Hosting backend id (default: the project id).
#   FIRESTORE_DATABASES  the databases ttl and verify cover, space separated
#                        (default: "(default) signups-eu signups-asia").
#
# Order of operations (per environment):
#   1) ./setup.sh secret <project> && ./setup.sh worker-secret <project> && ./setup.sh signing-key <project>
#      (apphosting.<env>.yaml references both secrets: a secret must exist, with App
#      Hosting access, before any rollout, or the build fails. Without the signing
#      key, context pulls and webhooks fail closed.)
#   2) deploy
#   3) firebase deploy --only firestore:indexes --project <project>   (wait for READY)
#   4) ./setup.sh ttl <project>
#   5) APP_URL=https://app.example.com ./setup.sh scheduler <project>   (the tick no-ops while LIFECYCLE_ENABLED is off)
#   6) ./setup.sh verify <project>
#
# What the TTLs delete (see src/lib/connect/*, src/lib/lifecycle/*):
#   product_events.ttlAt      ingested events, 90 days after receipt
#   product_users.ttlAt       deleted-user tombstones, 30 days after erasure
#   lifecycle_counters.ttlAt  daily send/enrolment counters, 40 days
#   lifecycle_drafts.ttlAt    AI-line drafts, 90 days after their send
#   rate_limits.ttl           ingest rate-limit counters, 2 hours (control plane only)

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-}"

usage() { sed -n '2,42p' "$0"; }

case "$CMD" in
  secret|worker-secret|signing-key|rotate-signing-key|retire-signing-key|ttl|scheduler|run|verify) ;;
  *) usage; exit 0 ;;
esac
if [ -z "$PROJECT" ]; then
  echo "Usage: $0 $CMD <project>" >&2
  exit 2
fi

SECRET_NAME="connect-secret-enc-key"
WORKER_SECRET_NAME="lifecycle-worker-secret"
# The App Hosting backend id. Defaults to the project id; set BACKEND for another.
BACKEND="${BACKEND:-$PROJECT}"
# Every database in firebase.json (control plane + regional data planes).
read -r -a DATABASES <<<"${FIRESTORE_DATABASES:-(default) signups-eu signups-asia}"

# Signs platform-to-product requests (context pulls, webhooks) as ES256 JWTs; the
# public keys are served at /.well-known/jwks.json. HSM-backed, non-exportable.
# Cloud KMS never rotates asymmetric keys itself: rotate by hand, yearly or on
# suspicion (rotate-signing-key, then retire-signing-key a few days later).
KMS_LOCATION="us-central1"
KEYRING="yougrow-connect"
SIGNING_KEY="outbound-signing"
SIGNING_KEY_NAME="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KEYRING}/cryptoKeys/${SIGNING_KEY}"

JOB_NAME="lifecycle-tick"
LOCATION="us-central1"   # Scheduler region: an HTTP trigger only, carries no PII.
SCHEDULE="*/2 * * * *"

# The app's origin, from APP_URL (no trailing slash). Required by scheduler.
TARGET_HOST="${APP_URL:-}"
TARGET_HOST="${TARGET_HOST%/}"
if [ -n "$TARGET_HOST" ] && ! [[ "$TARGET_HOST" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "APP_URL must be an https origin with no path, e.g. https://app.example.com (got '$TARGET_HOST')." >&2
  exit 2
fi
require_app_url() {
  if [ -z "$TARGET_HOST" ]; then
    echo "Set APP_URL to your app's https origin, e.g.: APP_URL=https://app.example.com $0 $CMD $PROJECT" >&2
    exit 2
  fi
}
URI="${TARGET_HOST}/api/admin/lifecycle/tick"

# App Hosting needs MORE than secretAccessor: it resolves `versions/latest`
# (viewer) through its service agent (secretVersionManager). A plain IAM grant
# fails the build with "Error resolving secret version". This is the supported way.
grant_backend() { # <secret>
  echo "==> Granting App Hosting backend '$BACKEND' access to $1"
  firebase apphosting:secrets:grantaccess "$1" --backend "$BACKEND" --project "$PROJECT" --non-interactive
}

# The service account the App Hosting backend runs as (its runtime identity).
runtime_sa() {
  local sa
  sa="$(gcloud apphosting backends describe "$BACKEND" --location=us-central1 --project="$PROJECT" \
    --format='value(serviceAccount)' 2>/dev/null || true)"
  echo "${sa:-firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com}"
}

ttl_on() { # <database> <collection-group> <field>
  echo "==> TTL ${2}.${3} on ${1} (${PROJECT})"
  gcloud firestore fields ttls update "$3" \
    --collection-group="$2" --enable-ttl --database="$1" --project="$PROJECT" --async
}

case "$CMD" in
  secret)
    if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
      echo "==> Secret $SECRET_NAME already exists in $PROJECT (not rotating it)"
    else
      echo "==> Creating secret $SECRET_NAME in $PROJECT (32 random bytes, base64)"
      gcloud secrets create "$SECRET_NAME" --project="$PROJECT" --replication-policy="automatic"
      openssl rand -base64 32 | tr -d '\n' \
        | gcloud secrets versions add "$SECRET_NAME" --project="$PROJECT" --data-file=-
    fi
    grant_backend "$SECRET_NAME"
    echo "Done. CONNECT_SECRET_ENC_KEY is referenced from apphosting.<env>.yaml."
    ;;
  worker-secret)
    if gcloud secrets describe "$WORKER_SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
      echo "==> Secret $WORKER_SECRET_NAME already exists in $PROJECT (not rotating it)"
    else
      echo "==> Creating secret $WORKER_SECRET_NAME in $PROJECT (256-bit random, hex)"
      gcloud secrets create "$WORKER_SECRET_NAME" --project="$PROJECT" --replication-policy="automatic"
      openssl rand -hex 32 | tr -d '\n' \
        | gcloud secrets versions add "$WORKER_SECRET_NAME" --project="$PROJECT" --data-file=-
    fi
    grant_backend "$WORKER_SECRET_NAME"
    echo "Done. LIFECYCLE_WORKER_SECRET is referenced from apphosting.<env>.yaml."
    ;;
  signing-key)
    gcloud services enable cloudkms.googleapis.com --project="$PROJECT"
    if ! gcloud kms keyrings describe "$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
      echo "==> Creating key ring $KEYRING ($KMS_LOCATION)"
      gcloud kms keyrings create "$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT"
    fi
    if gcloud kms keys describe "$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
      echo "==> Key $SIGNING_KEY already exists (not rotating it)"
    else
      echo "==> Creating $SIGNING_KEY (EC_SIGN_P256_SHA256, HSM)"
      gcloud kms keys create "$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT" \
        --purpose=asymmetric-signing --default-algorithm=ec-sign-p256-sha256 --protection-level=hsm
    fi
    sa="$(runtime_sa)"
    # Least privilege, on this key only: sign, read public keys, list versions.
    # No encrypt/decrypt, no admin, nothing project-wide.
    for role in roles/cloudkms.signer roles/cloudkms.publicKeyViewer roles/cloudkms.viewer; do
      echo "==> Granting $role on $SIGNING_KEY to $sa"
      gcloud kms keys add-iam-policy-binding "$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" \
        --project="$PROJECT" --member="serviceAccount:${sa}" --role="$role" --condition=None >/dev/null
    done
    echo "Done. Set CONNECT_SIGNING_KMS_KEY=${SIGNING_KEY_NAME}"
    ;;
  rotate-signing-key)
    echo "==> Adding a version to $SIGNING_KEY. It is published in the JWKS now and starts signing after 24 h."
    gcloud kms keys versions create --key="$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT"
    echo "After it signs (24 h+), wait a few days, then: ./setup.sh retire-signing-key $PROJECT <old-version>"
    ;;
  retire-signing-key)
    version="${3:?usage: ./setup.sh retire-signing-key <project> <version>}"
    echo "==> Disabling $SIGNING_KEY version $version (drops out of the JWKS; re-enable to undo)"
    gcloud kms keys versions disable "$version" --key="$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" --project="$PROJECT"
    ;;
  scheduler)
    require_app_url
    # The header must match what the app validates; the value is read from Secret
    # Manager and never appears in this script or shell history.
    value="$(gcloud secrets versions access latest --secret="$WORKER_SECRET_NAME" --project="$PROJECT")"
    action="create"
    if gcloud scheduler jobs describe "$JOB_NAME" --project="$PROJECT" --location="$LOCATION" >/dev/null 2>&1; then
      action="update"
    fi
    echo "==> ${action} Cloud Scheduler job '$JOB_NAME' in $PROJECT: '$SCHEDULE' -> POST $URI"
    gcloud scheduler jobs "$action" http "$JOB_NAME" \
      --project="$PROJECT" \
      --location="$LOCATION" \
      --schedule="$SCHEDULE" \
      --time-zone="Etc/UTC" \
      --uri="$URI" \
      --http-method=POST \
      --headers="X-Worker-Secret=${value}" \
      --attempt-deadline=120s \
      --max-retry-attempts=0
    ;;
  run)
    gcloud scheduler jobs run "$JOB_NAME" --project="$PROJECT" --location="$LOCATION"
    echo "Triggered. Check the job's last attempt with: ./setup.sh verify $PROJECT"
    ;;
  ttl)
    for db in "${DATABASES[@]}"; do
      ttl_on "$db" product_events ttlAt
      ttl_on "$db" product_users ttlAt
      ttl_on "$db" lifecycle_counters ttlAt
      ttl_on "$db" lifecycle_drafts ttlAt
    done
    ttl_on "(default)" rate_limits ttl
    echo "Requested. TTL policies take a few minutes to become ACTIVE. Check with: ./setup.sh verify $PROJECT"
    ;;
  verify)
    echo "==> Signing key versions ($SIGNING_KEY)"
    gcloud kms keys versions list --key="$SIGNING_KEY" --keyring="$KEYRING" --location="$KMS_LOCATION" \
      --project="$PROJECT" --format="table(name.basename(),state,algorithm,protectionLevel,createTime)" 2>/dev/null \
      || echo "    (not created. Run: ./setup.sh signing-key $PROJECT)"
    if [ -n "$TARGET_HOST" ]; then
      echo "==> Published keys: ${TARGET_HOST}/.well-known/jwks.json"
      curl -fsS "${TARGET_HOST}/.well-known/jwks.json" 2>/dev/null | head -c 600 || echo "    (not reachable)"
      echo
    else
      echo "==> Published keys: set APP_URL to check /.well-known/jwks.json"
    fi
    for name in "$SECRET_NAME" "$WORKER_SECRET_NAME"; do
      echo "==> Secret binding: $name"
      gcloud secrets get-iam-policy "$name" --project="$PROJECT" --format="table(bindings.role,bindings.members)" || true
    done
    echo "==> Scheduler job"
    gcloud scheduler jobs describe "$JOB_NAME" --project="$PROJECT" --location="$LOCATION" \
      --format="yaml(name,schedule,state,httpTarget.uri,lastAttemptTime,status)" 2>/dev/null \
      || echo "    (not created. Run: APP_URL=<your app origin> ./setup.sh scheduler $PROJECT)"
    for db in "${DATABASES[@]}"; do
      echo "==> TTL fields on ${db}"
      gcloud firestore fields ttls list --database="$db" --project="$PROJECT" || true
    done
    ;;
esac
