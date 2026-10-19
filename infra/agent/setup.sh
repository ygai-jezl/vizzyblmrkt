#!/usr/bin/env bash
#
# Provision the identities for Vizzy, the root agent (agents/root_agent), in one
# Google Cloud project. Run it before the first agents/root_agent/deploy.sh.
#
# Identities:
#   root-agent@<project>                      the agent's own runtime service account
#       roles/aiplatform.user (Gemini, Sessions, Memory Bank) + roles/logging.logWriter
#       It needs nothing for app data: the agent reaches it only through the app's
#       signed callback routes.
#   firebase-app-hosting-compute@<project>    the App Hosting runtime (the chat proxy)
#       reasoningEngineInvoker (aiplatform.reasoningEngines.query + .get), a custom role,
#       instead of the broad roles/aiplatform.user
#   you (the deployer)                        roles/iam.serviceAccountUser on root-agent@,
#       so the deploy can attach that identity to the engine
#
# Usage:
#   ./setup.sh sa     <project>   # enable the Vertex AI API, create root-agent@<project> (idempotent)
#   ./setup.sh roles  <project>   # create/update the reasoningEngineInvoker custom role
#   ./setup.sh iam    <project>   # grant the roles above (idempotent)
#   ./setup.sh verify <project>   # show the agent's roles and who holds the invoker role
#   ./setup.sh all    <project>   # sa, roles, iam, verify
#
#   <project> is your Google Cloud project id.
#
# Settings: RUNTIME_SA overrides the App Hosting runtime service account (default
# firebase-app-hosting-compute@<project>.iam.gserviceaccount.com).
#
# Then deploy the agent (agents/root_agent/deploy.sh) and set ROOT_AGENT_RESOURCE_ID
# in apphosting.<env>.yaml to the engine id it prints.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-}"

case "${CMD}" in
  sa|roles|iam|verify|all) ;;
  *) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
if [ -z "${PROJECT}" ]; then
  echo "Usage: $0 ${CMD} <project>" >&2
  exit 2
fi
if ! [[ "${PROJECT}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Not a Google Cloud project id: '${PROJECT}'" >&2
  exit 2
fi

AGENT_SA_NAME="root-agent"
AGENT_SA="${AGENT_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA:-firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com}"
INVOKER_ROLE="reasoningEngineInvoker"
AGENT_ROLES=("roles/aiplatform.user" "roles/logging.logWriter")

# The identity running this script needs actAs on the agent SA to attach it to the engine.
DEPLOYER="$(gcloud config get-value account 2>/dev/null || true)"
case "${DEPLOYER}" in
  *gserviceaccount.com) DEPLOYER_MEMBER="serviceAccount:${DEPLOYER}" ;;
  "")                   DEPLOYER_MEMBER="" ;;
  *)                    DEPLOYER_MEMBER="user:${DEPLOYER}" ;;
esac

sa() {
  echo "==> Enabling the Vertex AI and IAM APIs in ${PROJECT}"
  gcloud services enable aiplatform.googleapis.com iam.googleapis.com --project="${PROJECT}"
  echo "==> Agent service account ${AGENT_SA}"
  if gcloud iam service-accounts describe "${AGENT_SA}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "    exists, skipping"
  else
    gcloud iam service-accounts create "${AGENT_SA_NAME}" --project="${PROJECT}" \
      --display-name="YouGrow root agent (Vizzy) runtime" >/dev/null
    echo "    created"
  fi
}

roles() {
  echo "==> Custom role ${INVOKER_ROLE} in ${PROJECT}"
  local perms="aiplatform.reasoningEngines.query,aiplatform.reasoningEngines.get"
  if gcloud iam roles describe "${INVOKER_ROLE}" --project="${PROJECT}" >/dev/null 2>&1; then
    # Keep permissions in sync; tolerate "no changes".
    gcloud iam roles update "${INVOKER_ROLE}" --project="${PROJECT}" --permissions="${perms}" >/dev/null 2>&1 || true
    echo "    exists, permissions synced"
  else
    gcloud iam roles create "${INVOKER_ROLE}" --project="${PROJECT}" --title="Reasoning Engine Invoker" \
      --description="Query one deployed agent (YouGrow chat proxy)" --permissions="${perms}" --stage=GA >/dev/null
    echo "    created"
  fi
}

iam() {
  echo "==> Agent (${AGENT_SA}) roles"
  for r in "${AGENT_ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${AGENT_SA}" --role="${r}" --condition=None >/dev/null
    echo "    + ${r}"
  done
  echo "==> App Hosting runtime (${RUNTIME_SA}) may query the agent"
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" --role="projects/${PROJECT}/roles/${INVOKER_ROLE}" --condition=None >/dev/null
  echo "    + ${INVOKER_ROLE}"
  if [ -n "${DEPLOYER_MEMBER}" ]; then
    echo "==> Let the deployer (${DEPLOYER}) attach ${AGENT_SA} to the engine (actAs)"
    gcloud iam service-accounts add-iam-policy-binding "${AGENT_SA}" --project="${PROJECT}" \
      --member="${DEPLOYER_MEMBER}" --role="roles/iam.serviceAccountUser" >/dev/null
    echo "    + serviceAccountUser for ${DEPLOYER}"
  else
    echo "    No active gcloud account, so the actAs grant was skipped. Grant roles/iam.serviceAccountUser on ${AGENT_SA} to whoever deploys."
  fi
}

verify() {
  echo "==> Agent (${AGENT_SA}) project roles"
  gcloud projects get-iam-policy "${PROJECT}" --flatten="bindings[].members" \
    --filter="bindings.members:serviceAccount:${AGENT_SA}" \
    --format="value(bindings.role)" 2>/dev/null || true
  echo "==> Who holds ${INVOKER_ROLE} (want ${RUNTIME_SA})"
  gcloud projects get-iam-policy "${PROJECT}" --flatten="bindings[].members" \
    --filter="bindings.role:projects/${PROJECT}/roles/${INVOKER_ROLE}" \
    --format="value(bindings.members)" 2>/dev/null || true
}

case "${CMD}" in
  sa)     sa ;;
  roles)  roles ;;
  iam)    iam ;;
  verify) verify ;;
  all)    sa; roles; iam; verify
          echo
          echo "==> Next: deploy the agent, e.g."
          echo "    PROJECT=${PROJECT} CANVAS_CALLBACK_URL=https://<your app origin> bash agents/root_agent/deploy.sh" ;;
esac
