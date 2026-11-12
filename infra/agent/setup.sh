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
# Optional: Vizzy learning how each person edits (EDIT_MODE_VIZZY_LEARNING_ENABLED).
#   The memory step makes a Memory Bank of its own (memory-bank.json beside this script)
#   and lets firebase-app-hosting-compute@ read and write only memories scoped to a brand
#   (roles/aiplatform.memoryUser with an IAM condition on the memory's scope).
#
# Usage:
#   ./setup.sh sa     <project>   # enable the Vertex AI API, create root-agent@<project> (idempotent)
#   ./setup.sh roles  <project>   # create/update the reasoningEngineInvoker custom role
#   ./setup.sh iam    <project>   # grant the roles above (idempotent)
#   ./setup.sh verify <project>   # show the agent's roles and who holds the invoker role
#   ./setup.sh all    <project>   # sa, roles, iam, verify
#   ./setup.sh memory <project>   # optional: the Memory Bank for learning, and its grant
#                                 # (DRY_RUN=1 shows what it would do and changes nothing)
#
#   <project> is your Google Cloud project id.
#
# Settings: RUNTIME_SA overrides the App Hosting runtime service account (default
# firebase-app-hosting-compute@<project>.iam.gserviceaccount.com). REGION is where the
# Memory Bank goes (default us-central1, the agent's region).
#
# Then deploy the agent (agents/root_agent/deploy.sh) and set ROOT_AGENT_RESOURCE_ID
# in apphosting.<env>.yaml to the engine id it prints. After the memory step, set
# VIZZY_MEMORY_BANK_ID to the id it prints.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-}"

case "${CMD}" in
  sa|roles|iam|verify|all|memory) ;;
  *) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
REGION="${REGION:-us-central1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMORY_CONFIG="${SCRIPT_DIR}/memory-bank.json"
MEMORY_ROLE="roles/aiplatform.memoryUser"

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
  echo "==> Memory Bank for learning (optional) in ${REGION}"
  local bank
  bank="$(memory_bank_id 2>/dev/null || true)"
  echo "    ${bank:-none (the memory step makes one)}"
  echo "==> Who holds ${MEMORY_ROLE} (want ${RUNTIME_SA}, with the yougrow-edit-memories condition)"
  gcloud projects get-iam-policy "${PROJECT}" --flatten="bindings[].members" \
    --filter="bindings.role:${MEMORY_ROLE}" \
    --format="value(bindings.members,bindings.condition.title)" 2>/dev/null || true
}

# The Memory Bank's id, found by its display name, or empty.
memory_bank_id() {
  local api="https://${REGION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${REGION}"
  local name
  name="$(node -e 'process.stdout.write(require(process.argv[1]).displayName)' "${MEMORY_CONFIG}")"
  curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    "${api}/reasoningEngines?filter=display_name%3D%22${name}%22" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=(JSON.parse(s||"{}").reasoningEngines||[])[0];process.stdout.write(e?e.name.split("/").pop():"")})'
}

memory() {
  local api="https://${REGION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${REGION}"
  local condition
  condition="$(mktemp)"
  cat > "${condition}" <<'JSON'
{
  "title": "yougrow-edit-memories",
  "description": "Only memories scoped to a YouGrow brand (Vizzy in Edit mode)",
  "expression": "'tenant_id' in api.getAttribute('aiplatform.googleapis.com/memoryScope', {})"
}
JSON
  local existing
  existing="$(memory_bank_id)"
  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "==> Dry run, nothing changes in ${PROJECT}"
    if [ -n "${existing}" ]; then
      echo "    Memory Bank ${existing} exists in ${REGION}: its settings would be replaced from ${MEMORY_CONFIG}"
    else
      echo "    A Memory Bank would be made in ${REGION} from ${MEMORY_CONFIG}"
    fi
    echo "    ${RUNTIME_SA} would get ${MEMORY_ROLE} with this condition:"
    sed 's/^/      /' "${condition}"
    rm -f "${condition}"
    return
  fi
  local token
  token="$(gcloud auth print-access-token)"
  if [ -n "${existing}" ]; then
    echo "==> Memory Bank ${existing} exists in ${REGION}: updating its settings"
    node -e 'const c=require(process.argv[1]);process.stdout.write(JSON.stringify({contextSpec:c.contextSpec}))' "${MEMORY_CONFIG}" |
      curl -fsS -X PATCH -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
        --data-binary @- "${api}/reasoningEngines/${existing}?updateMask=contextSpec" >/dev/null
  else
    echo "==> Making the Memory Bank in ${REGION}"
    local op
    op="$(curl -fsS -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
      --data-binary @"${MEMORY_CONFIG}" "${api}/reasoningEngines" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name||""))')"
    existing="$(echo "${op}" | sed -n 's#.*/reasoningEngines/\([0-9]*\)/operations/.*#\1#p')"
    if [ -z "${existing}" ]; then
      echo "    Couldn't read the new Memory Bank's id from: ${op}" >&2
      rm -f "${condition}"
      exit 1
    fi
    echo "    made"
  fi
  echo "==> ${RUNTIME_SA} may read and write memories scoped to a brand"
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" --role="${MEMORY_ROLE}" --condition-from-file="${condition}" >/dev/null
  rm -f "${condition}"
  echo "    + ${MEMORY_ROLE} (only memories whose scope has tenant_id)"
  echo
  echo "==> Set VIZZY_MEMORY_BANK_ID to ${existing} in apphosting.<env>.yaml, then EDIT_MODE_VIZZY_LEARNING_ENABLED."
}

case "${CMD}" in
  sa)     sa ;;
  roles)  roles ;;
  iam)    iam ;;
  verify) verify ;;
  memory) memory ;;
  all)    sa; roles; iam; verify
          echo
          echo "==> Next: deploy the agent, e.g."
          echo "    PROJECT=${PROJECT} CANVAS_CALLBACK_URL=https://<your app origin> bash agents/root_agent/deploy.sh" ;;
esac
