#!/usr/bin/env bash
#
# Provision the connected-product lifecycle feature (Products → connections,
# ingest API, sandbox). Per GCP project; run against dev first, then prod.
#
#   ./setup.sh secret <project>   # create connect-secret-enc-key + grant the runtime SA (REVERSIBLE)
#   ./setup.sh ttl    <project>   # Firestore TTL policies on every database (REVERSIBLE)
#   ./setup.sh verify <project>   # show the secret binding + TTL state
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# Order of operations (per environment):
#   1) ./setup.sh secret <project>
#   2) uncomment CONNECT_SECRET_ENC_KEY in apphosting(.prod).yaml, then deploy
#      (the secret must exist before a rollout references it)
#   3) firebase deploy --only firestore:indexes --project <dev|prod>   (wait for READY)
#   4) ./setup.sh ttl <project>
#   5) ./setup.sh verify <project>
#
# What the TTLs delete (see src/lib/connect/*):
#   product_events.ttlAt  — ingested events, 90 days after receipt
#   product_users.ttlAt   — deleted-user tombstones, 30 days after erasure
#   rate_limits.ttl       — ingest rate-limit counters, 2 hours (control plane only)

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"

SECRET_NAME="connect-secret-enc-key"
RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"
# Every database in firebase.json (control plane + regional data planes).
DATABASES=("(default)" "signups-eu" "signups-asia")

case "$PROJECT" in
  vizzybl-marketing-dev|vizzybl-marketing-prod) ;;
  *) echo "Refusing: unexpected project '$PROJECT'" >&2; exit 2 ;;
esac

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
    echo "==> Granting $RUNTIME_SA read access"
    gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project="$PROJECT" \
      --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
    echo "Done. Next: uncomment CONNECT_SECRET_ENC_KEY in the apphosting yaml for this env and deploy."
    ;;
  ttl)
    for db in "${DATABASES[@]}"; do
      ttl_on "$db" product_events ttlAt
      ttl_on "$db" product_users ttlAt
    done
    ttl_on "(default)" rate_limits ttl
    echo "Requested. TTL policies take a few minutes to become ACTIVE — check with: ./setup.sh verify $PROJECT"
    ;;
  verify)
    echo "==> Secret binding"
    gcloud secrets get-iam-policy "$SECRET_NAME" --project="$PROJECT" --format="table(bindings.role,bindings.members)" || true
    for db in "${DATABASES[@]}"; do
      echo "==> TTL fields on ${db}"
      gcloud firestore fields ttls list --database="$db" --project="$PROJECT" || true
    done
    ;;
  *)
    sed -n '2,25p' "$0"
    ;;
esac
