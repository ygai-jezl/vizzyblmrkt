#!/usr/bin/env bash
#
# Provision "Invite your waitlist" (nav v2 phase 4) in a GCP project: the key that
# signs invite links, in Secret Manager, readable by the project's App Hosting
# backend. Run it once per project (e.g. staging first, then production).
#
#   ./setup.sh secret <project> [backend]   # create invite-link-signing-key + grant the backend (REVERSIBLE)
#   ./setup.sh verify <project>             # show the secret, its versions and its bindings
#
#   [backend] is the App Hosting backend id; it defaults to <project>.
#
# The key signs invite links (/invite/<payload>.<signature>, HMAC-SHA256 with a
# purpose prefix — see src/lib/invites/token.ts), following Google's signed-URL
# pattern: an expiry and a key name inside the signed part, the key kept in
# Secret Manager, and one secret per purpose and per environment (never shared
# with the unsubscribe or canvas keys, never shared between environments).
#
# ORDER: apphosting.yaml references this secret by name, so it must exist (with
# App Hosting access) in a project BEFORE code that references it is deployed
# there — otherwise the build fails. Without it, invites stay locked ("Invite
# links aren't set up yet") and nothing else changes.
#
# ROTATION (rare; e.g. on suspicion of exposure). Links carry a fingerprint of the
# key that signed them, so old links keep working while the old key is PREVIOUS:
#   1) gcloud secrets create invite-link-signing-key-previous --project <p> --replication-policy=automatic
#      gcloud secrets versions access latest --secret invite-link-signing-key --project <p> \
#        | gcloud secrets versions add invite-link-signing-key-previous --project <p> --data-file=-
#      firebase apphosting:secrets:grantaccess invite-link-signing-key-previous --backend <b> --project <p>
#   2) reference it as INVITE_LINK_SIGNING_KEY_PREVIOUS in apphosting.yaml (secret, RUNTIME)
#   3) openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add invite-link-signing-key --project <p> --data-file=-
#   4) deploy; after 90 days (the longest link lifetime) remove the PREVIOUS reference.
# Nothing here ever prints a key.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-}"
BACKEND="${3:-$PROJECT}"
SECRET_NAME="invite-link-signing-key"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

if [ "$CMD" != "secret" ] && [ "$CMD" != "verify" ]; then
  usage
  exit 0
fi
if [ -z "$PROJECT" ]; then
  echo "Usage: $0 $CMD <project> [backend]" >&2
  exit 2
fi

# Both CLIs must be able to act on this project BEFORE anything is created, so an
# expired login can't leave the key created but App Hosting without access to it.
preflight() {
  gcloud secrets list --project="$PROJECT" --limit=1 --quiet >/dev/null 2>&1 \
    || { echo "gcloud can't reach Secret Manager in $PROJECT. Run: gcloud auth login" >&2; exit 1; }
  firebase apphosting:backends:get "$BACKEND" --project "$PROJECT" >/dev/null 2>&1 \
    || { echo "The Firebase CLI can't see App Hosting backend '$BACKEND' in $PROJECT." >&2
         echo "Run: firebase login --reauth (or pass the backend id as the third argument)." >&2; exit 1; }
}

case "$CMD" in
  secret)
    preflight
    if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
      echo "==> Secret $SECRET_NAME already exists in $PROJECT (not rotating it)"
    else
      echo "==> Creating secret $SECRET_NAME in $PROJECT (32 random bytes, base64)"
      gcloud secrets create "$SECRET_NAME" --project="$PROJECT" --replication-policy="automatic"
      openssl rand -base64 32 | tr -d '\n' \
        | gcloud secrets versions add "$SECRET_NAME" --project="$PROJECT" --data-file=-
    fi
    # App Hosting needs its own grant (a plain secretAccessor binding fails the build).
    echo "==> Granting App Hosting backend '$BACKEND' access to $SECRET_NAME"
    firebase apphosting:secrets:grantaccess "$SECRET_NAME" --backend "$BACKEND" --project "$PROJECT" --non-interactive
    echo "Done. INVITE_LINK_SIGNING_KEY is referenced from apphosting.yaml."
    ;;
  verify)
    echo "==> Secret $SECRET_NAME in $PROJECT"
    gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" --format="value(name,createTime)" 2>/dev/null \
      || { echo "    (missing — run: $0 secret $PROJECT)"; exit 1; }
    echo "==> Versions"
    gcloud secrets versions list "$SECRET_NAME" --project="$PROJECT" --format="table(name,state,createTime)"
    echo "==> Bindings"
    gcloud secrets get-iam-policy "$SECRET_NAME" --project="$PROJECT" --format="table(bindings.role,bindings.members)" || true
    ;;
esac
