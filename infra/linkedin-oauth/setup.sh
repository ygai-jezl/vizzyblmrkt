#!/usr/bin/env bash
#
# Provision the LinkedIn OAuth 2.0 secrets for the Distribute "Connect LinkedIn" flow.
#
# Two secrets back the flow (src/app/api/admin/integrations/linkedin/{start,callback}):
#   linkedin-oauth-client-id      — OAuth 2.0 Client ID from the LinkedIn app
#   linkedin-oauth-client-secret  — OAuth 2.0 Client Secret (confidential client)
# (social-token-enc-key is SHARED with the X flow — already provisioned by
#  infra/x-oauth/setup.sh; this script does NOT recreate it.)
#
# Prereq — create the LinkedIn app first (developer.linkedin.com/apps):
#   1. Create app + associate it with a LinkedIn COMPANY PAGE (required).
#   2. Products tab → request:
#        - "Sign In with LinkedIn using OpenID Connect"  (openid profile → the member id)
#        - "Share on LinkedIn"                           (w_member_social → post; NEEDS REVIEW)
#   3. Auth tab → add the Authorized redirect URL EXACTLY:
#        https://<host>/api/admin/integrations/linkedin/callback
#      (dev host: vizzybl-marketing-dev--vizzybl-marketing-dev.us-central1.hosted.app)
#   4. Copy the Client ID + Client Secret.
#
# Usage:
#   ./setup.sh secret <project>   # create the 2 secrets + grant the runtime SA (REVERSIBLE)
#   ./setup.sh verify <project>   # show the secret IAM bindings
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# After: uncomment the LINKEDIN_OAUTH_* block in apphosting.<env>.yaml, run
#   firebase apphosting:secrets:grantaccess linkedin-oauth-client-id     --backend <backend> --project <project>
#   firebase apphosting:secrets:grantaccess linkedin-oauth-client-secret --backend <backend> --project <project>
# (the full IAM triple), deploy, then Connect LinkedIn from /admin/account/connections.

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
  echo "==> Provisioning LinkedIn OAuth secrets in ${PROJECT}"
  read -r -p "    LinkedIn OAuth 2.0 Client ID: " LI_ID
  read -r -s -p "    LinkedIn OAuth 2.0 Client Secret: " LI_SECRET; echo

  create_secret "linkedin-oauth-client-id" "${LI_ID}"
  create_secret "linkedin-oauth-client-secret" "${LI_SECRET}"

  echo "==> Done. Uncomment the LINKEDIN_OAUTH_* block in apphosting.<env>.yaml, grant the"
  echo "    full triple (firebase apphosting:secrets:grantaccess ...), deploy, then Connect LinkedIn."
}

verify() {
  for s in linkedin-oauth-client-id linkedin-oauth-client-secret; do
    echo "==> ${s}"
    gcloud secrets get-iam-policy "${s}" --project="${PROJECT}" --format="yaml(bindings)" 2>/dev/null \
      || echo "    (not found — run: ./setup.sh secret ${PROJECT})"
  done
}

case "${CMD}" in
  secret) secret ;;
  verify) verify ;;
  *)
    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
