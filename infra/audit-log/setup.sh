#!/usr/bin/env bash
#
# Provision the WORM (write-once-read-many) audit-log bucket that backs the
# tamper-resistant audit trail (see src/lib/tenant/auditSink.ts + README.md).
#
# The bucket is a GCS bucket with a LOCKED retention policy. The App Hosting
# runtime service account is granted roles/storage.objectCreator ONLY, so it can
# append a new audit object but can never read, overwrite, or delete one; the
# locked retention policy additionally blocks deletion by ANY identity until the
# records age out. Together that makes the trail resistant to tampering by the
# very operators it audits.
#
# Usage:
#   ./setup.sh provision <project>   # create bucket + retention + IAM (REVERSIBLE)
#   ./setup.sh verify    <project>   # show config + list objects + WORM check
#   ./setup.sh lock      <project>   # LOCK retention — IRREVERSIBLE; run only after verify
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# Order of operations: provision -> deploy app with AUDIT_LOG_BUCKET set ->
# delete a throwaway launch -> verify the object landed -> lock.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"

BUCKET="${PROJECT}-audit-log"
LOCATION="US"                 # US multi-region (allowed by the gcp.resourceLocations org policy)
RETENTION="P2555D"           # 7 years (ISO-8601 duration); records are PII-free metadata (tiny)
RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"

gsuri="gs://${BUCKET}"

provision() {
  echo "==> Provisioning ${gsuri} in ${PROJECT}"

  if gcloud storage buckets describe "${gsuri}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "    bucket already exists — skipping create"
  else
    echo "    creating bucket (uniform access, public-access prevention enforced)"
    gcloud storage buckets create "${gsuri}" \
      --project="${PROJECT}" \
      --location="${LOCATION}" \
      --uniform-bucket-level-access \
      --public-access-prevention
  fi

  echo "    setting ${RETENTION} retention (NOT yet locked — reversible)"
  gcloud storage buckets update "${gsuri}" --project="${PROJECT}" --retention-period="${RETENTION}"

  echo "    granting ${RUNTIME_SA} create-only (roles/storage.objectCreator)"
  # objectCreator = storage.objects.create only — NOT get/list/delete/overwrite.
  # The runtime SA is a same-org SA, so org-domain-restricted-sharing does not
  # block this grant (unlike grants to external / Google-managed SAs).
  gcloud storage buckets add-iam-policy-binding "${gsuri}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/storage.objectCreator"

  echo "==> Done. Deploy with AUDIT_LOG_BUCKET=${BUCKET}, verify, THEN lock."
}

verify() {
  echo "==> Config for ${gsuri}"
  gcloud storage buckets describe "${gsuri}" --project="${PROJECT}" \
    --format="yaml(name,location,uniform_bucket_level_access,public_access_prevention,retention_policy)"

  echo "==> Recent audit objects"
  gcloud storage ls "${gsuri}/audit/launch-delete/" --project="${PROJECT}" 2>/dev/null | tail -n 20 || echo "    (none yet)"

  echo "==> WORM IAM check (manual): the runtime SA must NOT be able to delete."
  echo "    Impersonate it and expect 'permission denied':"
  echo "      gcloud storage rm ${gsuri}/audit/launch-delete/<object>.json \\"
  echo "        --impersonate-service-account=${RUNTIME_SA}"
}

lock() {
  cat <<EOF
==> About to LOCK the retention policy on ${gsuri}.

    This is IRREVERSIBLE. After locking:
      - the policy can never be removed or SHORTENED;
      - no identity (incl. project owner) can delete an object before it is
        ${RETENTION} old, nor delete the bucket while it holds objects.

    Only proceed once you have VERIFIED (./setup.sh verify ${PROJECT}) that audit
    objects route correctly.
EOF
  read -r -p "    Type 'LOCK ${BUCKET}' to confirm: " confirm
  if [[ "${confirm}" != "LOCK ${BUCKET}" ]]; then
    echo "    Aborted."
    exit 1
  fi
  gcloud storage buckets update "${gsuri}" --project="${PROJECT}" --lock-retention-period
  echo "==> Retention policy LOCKED on ${gsuri}."
}

case "${CMD}" in
  provision) provision ;;
  verify)    verify ;;
  lock)      lock ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
