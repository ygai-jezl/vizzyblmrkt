#!/usr/bin/env bash
#
# Provision the root secret that seals each brand's OWN Mailchimp API key at rest
# (src/lib/mailchimp/keyBox.ts), in one Google Cloud project.
#
#   ./setup.sh secret <project>  # create mailchimp-key-enc-key + grant App Hosting (REVERSIBLE)
#   ./setup.sh verify <project>  # show the secret's versions and who can read it
#
# Settings (environment variables):
#   BACKEND   the App Hosting backend id (default: the project id).
#
# Order of operations (per environment):
#   1) ./setup.sh secret <project>
#      (then reference it from apphosting.<env>.yaml as MAILCHIMP_KEY_ENC_KEY: a secret
#      must exist, with App Hosting access, before any rollout, or the build fails.)
#   2) deploy, with MAILCHIMP_KEY_SEALED_ENABLED "true" in apphosting.<env>.yaml
#   3) seal keys saved before the switch:  scripts/seal-mailchimp-keys.ts
#
# Never rotate this by adding a new version: every sealed key would stop opening.
# Rotating means re-sealing every brand's key under the new root.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-}"

usage() { sed -n '2,20p' "$0"; }

case "$CMD" in
  secret|verify) ;;
  *) usage; exit 0 ;;
esac
if [ -z "$PROJECT" ]; then
  echo "Usage: $0 $CMD <project>" >&2
  exit 2
fi

BACKEND="${BACKEND:-$PROJECT}"
SECRET_NAME="mailchimp-key-enc-key"

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
    # App Hosting needs more than secretAccessor (it resolves versions/latest through
    # its service agent); a plain IAM grant fails the build. This is the supported way.
    echo "==> Granting App Hosting backend '$BACKEND' access to $SECRET_NAME"
    firebase apphosting:secrets:grantaccess "$SECRET_NAME" --backend "$BACKEND" --project "$PROJECT" --non-interactive
    echo "Done. Reference it from apphosting.<env>.yaml as MAILCHIMP_KEY_ENC_KEY (secret: $SECRET_NAME)."
    ;;
  verify)
    echo "==> Versions of $SECRET_NAME"
    gcloud secrets versions list "$SECRET_NAME" --project="$PROJECT" \
      --format="table(name.basename(),state,createTime)" 2>/dev/null \
      || echo "    (not created — run: ./setup.sh secret $PROJECT)"
    echo "==> Who can read it"
    gcloud secrets get-iam-policy "$SECRET_NAME" --project="$PROJECT" \
      --format="table(bindings.role,bindings.members)" 2>/dev/null || true
    ;;
esac
