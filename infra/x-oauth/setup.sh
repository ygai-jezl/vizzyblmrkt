#!/usr/bin/env bash
#
# Provision the X (Twitter) OAuth 2.0 secrets for the Distribute "Connect X" flow.
#
# Three secrets back the flow (src/app/api/admin/integrations/x/{start,callback}):
#   x-oauth-client-id      — OAuth 2.0 Client ID from the X developer app (public,
#                            but stored alongside the others for one grant)
#   x-oauth-client-secret  — OAuth 2.0 Client Secret (confidential client)
#   social-token-enc-key   — AES-256-GCM root key encrypting the per-tenant user
#                            tokens at rest (generated here; keep separate from the
#                            git GIT_TOKEN_ENC_KEY)
#
# Prereq: create the X app first (developer.x.com → Project + App → User auth
# settings → OAuth 2.0, Web App / confidential, callback
# https://<host>/api/admin/integrations/x/callback, scopes
# tweet.read tweet.write users.read offline.access). Copy the Client ID + Secret.
#
# Usage:
#   ./setup.sh secret <project>   # create the 3 secrets + grant the runtime SA (REVERSIBLE)
#   ./setup.sh verify <project>   # show the secret IAM bindings
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# After: uncomment the X_OAUTH_* + SOCIAL_TOKEN_ENC_KEY block in apphosting.<env>.yaml
# and deploy. Then Connect X from /admin/account/connections.

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
  echo "==> Provisioning X OAuth secrets in ${PROJECT}"
  read -r -p "    X OAuth 2.0 Client ID: " X_ID
  read -r -s -p "    X OAuth 2.0 Client Secret: " X_SECRET; echo
  local ENC
  ENC="$(openssl rand -base64 32)"

  create_secret "x-oauth-client-id" "${X_ID}"
  create_secret "x-oauth-client-secret" "${X_SECRET}"
  create_secret "social-token-enc-key" "${ENC}"

  echo "==> Done. Uncomment the X_OAUTH_* + SOCIAL_TOKEN_ENC_KEY block in apphosting.<env>.yaml, deploy, then Connect X."
}

verify() {
  for s in x-oauth-client-id x-oauth-client-secret social-token-enc-key; do
    echo "==> ${s}"
    gcloud secrets get-iam-policy "${s}" --project="${PROJECT}" --format="yaml(bindings)" 2>/dev/null \
      || echo "    (not found — run: ./setup.sh secret ${PROJECT})"
  done
}

case "${CMD}" in
  secret) secret ;;
  verify) verify ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
