#!/usr/bin/env bash
#
# Provision the LinkedIn Community-Management (App 2) OAuth secrets — Company Page
# posting via the CM API. This is a SEPARATE LinkedIn app from the personal one
# (CM must be the only product on its app), so it has its own credentials:
#   linkedin-cm-client-id      — App 2 OAuth 2.0 Client ID
#   linkedin-cm-client-secret  — App 2 OAuth 2.0 Client Secret
# (social-token-enc-key is SHARED — already provisioned by infra/x-oauth/setup.sh.)
#
# Prereq — create a NEW LinkedIn app whose ONLY product is Community Management API
# (developer.linkedin.com/apps), associate it with a Company Page, and add the
# redirect URL EXACTLY:
#   https://<host>/api/admin/integrations/linkedin_org/callback
# Community Management starts at Development Tier (test on Pages you admin); apply
# for Standard Tier to serve your users' Pages (needs an OAuth-flow screencast).
#
# Usage:
#   ./setup.sh secret <project>   # create the 2 secrets + grant the runtime SA
#   ./setup.sh verify <project>   # show the secret IAM bindings
#
# After: uncomment the LINKEDIN_CM_* block in apphosting.<env>.yaml, grant the full
# triple (firebase apphosting:secrets:grantaccess ...), deploy, then Connect LinkedIn
# Pages from /admin/account/connections.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"
RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"

create_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "${name}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "    ${name} exists — adding a new version"
  else
    echo "    creating ${name}"
    gcloud secrets create "${name}" --project="${PROJECT}" --replication-policy="automatic"
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${name}" --project="${PROJECT}" --data-file=-
  gcloud secrets add-iam-policy-binding "${name}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"
}

secret() {
  echo "==> Provisioning LinkedIn CM (App 2) OAuth secrets in ${PROJECT}"
  read -r -p "    LinkedIn CM OAuth 2.0 Client ID: " LI_ID
  read -r -s -p "    LinkedIn CM OAuth 2.0 Client Secret: " LI_SECRET; echo
  create_secret "linkedin-cm-client-id" "${LI_ID}"
  create_secret "linkedin-cm-client-secret" "${LI_SECRET}"
  echo "==> Done. Uncomment the LINKEDIN_CM_* block in apphosting.<env>.yaml, grant the"
  echo "    full triple, deploy, then Connect LinkedIn Pages."
}

verify() {
  for s in linkedin-cm-client-id linkedin-cm-client-secret; do
    echo "==> ${s}"
    gcloud secrets get-iam-policy "${s}" --project="${PROJECT}" --format="yaml(bindings)" 2>/dev/null \
      || echo "    (not found — run: ./setup.sh secret ${PROJECT})"
  done
}

case "${CMD}" in
  secret) secret ;;
  verify) verify ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
