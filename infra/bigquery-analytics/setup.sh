#!/usr/bin/env bash
#
# Provision the Firestore -> BigQuery hybrid-analytics pipeline (Phase 2).
# See docs/SETUP.md §11, src/lib/analytics/bigquery.ts, and
# memory feature-bigquery-analytics. The app code ships OFF by default
# (ANALYTICS_BQ_ENABLED="false"); this provisions the GCP side, then you flip
# the flag. Until the flag flips, the dashboard stays on the Firestore path.
#
# Pipeline per region (us / eu / asia):
#   signups       -(firestore-bigquery-export)-> waitlist_<r>.signups_raw_*       -> signups_latest (view)
#   email_events  -(firestore-bigquery-export)-> waitlist_<r>.email_events_raw_*  -> email_events_latest (view)
#   widget views  -(POST /api/track/view)------> waitlist_<r>.widget_views (app-owned table)
# => 6 extension instances (2 collections x 3 regions), 3 datasets, per project.
#
# Usage (run in ORDER; DEV first, validate, THEN prod):
#   ./setup.sh datasets   <project>   # create the 3 regional BQ datasets (idempotent)
#   ./setup.sh extensions <project>   # write 6 extension .env files at repo root + register firebase.json
#   #                                 #   THEN: firebase deploy --only extensions --project=<project>
#   ./setup.sh schema     <project>   # widget_views tables + signups_latest/email_events_latest views
#   ./setup.sh serviceaccounts <project> # wire each export function's OWN dedicated SA as its Eventarc invoker (off the default compute SA). RE-RUN after every extension deploy.
#   ./setup.sh iam        <project>   # grant the App Hosting runtime SA least-privilege BQ roles
#   ./setup.sh backfill   <project>   # import existing rows for both collections x 3 regions
#   ./setup.sh validate   <project>   # print BQ row counts to compare against Firestore
#   ./setup.sh verify     <project>   # show datasets / tables / views / IAM
#
#   <project> is vizzybl-marketing-dev (default) or vizzybl-marketing-prod.
#
# End-to-end order: datasets -> extensions -> (firebase deploy --only extensions)
#   -> schema -> serviceaccounts -> iam -> backfill -> validate -> flip ANALYTICS_BQ_ENABLED +
#   NEXT_PUBLIC_ANALYTICS_BQ_ENABLED to "true" in apphosting.<env>.yaml + deploy.
#
# Requires: gcloud, bq, firebase CLI, npx, jq. Blaze billing (already on).
# First-party in-project SA grants are NOT blocked by the org
# domain-restricted-sharing policy, so no temporary override is needed here.

set -euo pipefail

CMD="${1:-help}"
PROJECT="${2:-vizzybl-marketing-dev}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"

RUNTIME_SA="firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com"
EXT_REF="firebase/firestore-bigquery-export"
# Pin an explicit version: the publisher deprecated the stable line, so @latest
# resolves to nothing. 0.3.x derives the trigger region from DATABASE_REGION
# (no separate LOCATION param). Bump deliberately after testing a new version.
EXT_VERSION="0.3.2"
COLLECTIONS=("signups" "email_events")

# region | firestore database id | BQ dataset | BQ dataset location | functions/trigger location | firestore instance location
# (bash 3.2 on macOS has no associative arrays — use space-delimited specs.)
REGION_SPECS=(
  "us (default) waitlist_us us us-central1 nam5"
  "eu signups-eu waitlist_eu eu europe-west4 eur3"
  "asia signups-asia waitlist_asia asia-southeast1 asia-southeast1 asia-southeast1"
)

instance_id() { # <collection> <region>
  echo "fsbq-${1//_/-}-${2}"
}

# ----------------------------------------------------------------------------

buildperms() {
  # Cloud Functions (Gen1/Gen2) builds run as the DEFAULT compute SA, which no
  # longer receives build permissions automatically (Google's 2024 change). The
  # extension's functions fail to build without these. Grant them once per project.
  local pn csa
  pn="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
  csa="${pn}-compute@developer.gserviceaccount.com"
  echo "==> Granting Cloud Functions build roles to ${csa}"
  for role in roles/cloudbuild.builds.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
    gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${csa}" --role="${role}" --condition=None >/dev/null
    echo "    + ${role}"
  done
  echo "    Done. Re-run: firebase deploy --only extensions --project=${PROJECT}"
}

datasets() {
  echo "==> Creating regional BigQuery datasets in ${PROJECT}"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    if bq --project_id="${PROJECT}" show --dataset "${dataset}" >/dev/null 2>&1; then
      echo "    ${dataset} (${loc}) already exists — skipping"
    else
      bq --project_id="${PROJECT}" mk --dataset \
        --location="${loc}" \
        --description="Waitlist analytics — ${region} region (residency-isolated)" \
        "${PROJECT}:${dataset}"
      echo "    created ${dataset} @ ${loc}"
    fi
  done
}

extensions() {
  echo "==> Writing extension param files to ${ROOT}/extensions (6 instances)"
  # Remove the stale misplaced dir an earlier (buggy) run may have created.
  if [ -d "${SCRIPT_DIR}/extensions" ]; then rm -rf "${SCRIPT_DIR}/extensions"; fi
  mkdir -p "${ROOT}/extensions"

  local entries=""
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    for col in "${COLLECTIONS[@]}"; do
      local inst; inst="$(instance_id "${col}" "${region}")"
      cat >"${ROOT}/extensions/${inst}.env" <<EOF
# ${EXT_REF}@${EXT_VERSION} — ${col} in ${region} (DB ${db} @ ${fsloc}) -> ${dataset}.${col}_raw_*
# Trigger region derives from DATABASE_REGION (0.3.x: triggerRegion=\${DATABASE_REGION}).
COLLECTION_PATH=${col}
DATABASE=${db}
DATABASE_REGION=${fsloc}
DATASET_ID=${dataset}
DATASET_LOCATION=${loc}
TABLE_ID=${col}
WILDCARD_IDS=false
BIGQUERY_PROJECT_ID=${PROJECT}
EOF
      entries="${entries}{\"${inst}\":\"${EXT_REF}@${EXT_VERSION}\"}+"
      echo "    wrote extensions/${inst}.env"
    done
  done

  # Merge the 6 instances into firebase.json's .extensions (preserve everything else).
  local fb="${ROOT}/firebase.json"
  local merged; merged="$(printf '%s' "${entries%+}" | sed 's/+/ + /g')"
  jq ".extensions = ((.extensions // {}) + (${merged}))" "${fb}" >"${fb}.tmp" && mv "${fb}.tmp" "${fb}"
  echo "    registered 6 instances in firebase.json"

  cat <<EOF

Next — DEPLOY the extensions (provisions Cloud Functions; can take minutes and may
prompt to enable APIs / accept the extension's IAM):

  firebase deploy --only extensions --project=${PROJECT}

Then run: ./setup.sh schema ${PROJECT}

NOTES:
  - Pinned to ${EXT_REF}@${EXT_VERSION} (the publisher deprecated @latest). The
    trigger region derives from DATABASE_REGION (nam5 / eur3 / asia-southeast1),
    so PII stays in-region and there is no separate LOCATION param.
  - If a future version rejects a key, check params:
    \`firebase ext:info ${EXT_REF}@${EXT_VERSION}\`, then fix extensions/*.env.
  - extensions/*.env + firebase.json carry no secrets — commit them.
EOF
}

raw_latest_exists() { # <dataset> <collection>
  bq --project_id="${PROJECT}" show "${1}.${2}_raw_latest" >/dev/null 2>&1
}

schema() {
  echo "==> Creating widget_views tables + typed views in ${PROJECT}"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    local fq="${PROJECT}.${dataset}"

    # widget_views: app-owned impression table (PII-free) — independent of the
    # extension, so always create it.
    if bq --project_id="${PROJECT}" show "${dataset}.widget_views" >/dev/null 2>&1; then
      echo "    ${dataset}.widget_views already exists — skipping"
    else
      bq --project_id="${PROJECT}" mk --table \
        --time_partitioning_field=ingest_day --time_partitioning_type=DAY \
        --clustering_fields=tenant_id,campaign_id \
        "${PROJECT}:${dataset}.widget_views" \
        event_id:STRING,tenant_id:STRING,campaign_id:STRING,event_ts:TIMESTAMP,referrer_host:STRING,utm_source:STRING,utm_medium:STRING,utm_campaign:STRING,utm_content:STRING,utm_term:STRING,ua_class:STRING,is_bot:BOOLEAN,ingest_day:DATE
      echo "    created ${dataset}.widget_views"
    fi

    # The typed views require the extension's *_raw_latest views to exist.
    if raw_latest_exists "${dataset}" "signups"; then
      bq --project_id="${PROJECT}" --location="${loc}" query --use_legacy_sql=false "
        CREATE OR REPLACE VIEW \`${fq}.signups_latest\` AS
        SELECT
          document_id                                          AS signup_id,
          JSON_VALUE(data, '\$.tenantId')                      AS tenant_id,
          JSON_VALUE(data, '\$.campaignId')                    AS campaign_id,
          JSON_VALUE(data, '\$.status')                        AS status,
          JSON_VALUE(data, '\$.referredBySignupToken')         AS referred_by_token,
          CAST(JSON_VALUE(data, '\$.amountReferred') AS INT64) AS amount_referred,
          JSON_VALUE(data, '\$.utm.source')                    AS utm_source,
          JSON_VALUE(data, '\$.utm.medium')                    AS utm_medium,
          JSON_VALUE(data, '\$.utm.campaign')                  AS utm_campaign,
          JSON_VALUE(data, '\$.utm.content')                   AS utm_content,
          JSON_VALUE(data, '\$.utm.term')                      AS utm_term,
          JSON_VALUE(data, '\$.referrerUrl')                   AS referrer_url,
          TIMESTAMP(JSON_VALUE(data, '\$.createdAt'))          AS created_at
        FROM \`${fq}.signups_raw_latest\`
        WHERE operation != 'DELETE' AND JSON_VALUE(data, '\$.status') != 'deleted'
      " >/dev/null && echo "    ${dataset}.signups_latest"
    else
      echo "    ⚠️  ${dataset}.signups_raw_latest missing — deploy extensions first (skipping signups_latest)"
    fi

    if raw_latest_exists "${dataset}" "email_events"; then
      bq --project_id="${PROJECT}" --location="${loc}" query --use_legacy_sql=false "
        CREATE OR REPLACE VIEW \`${fq}.email_events_latest\` AS
        SELECT
          document_id                          AS event_id,
          JSON_VALUE(data, '\$.tenantId')      AS tenant_id,
          JSON_VALUE(data, '\$.campaignId')    AS campaign_id,
          JSON_VALUE(data, '\$.journeyId')     AS journey_id,
          JSON_VALUE(data, '\$.nodeId')        AS node_id,
          JSON_VALUE(data, '\$.signupId')      AS signup_id,
          JSON_VALUE(data, '\$.variantId')     AS variant_id,
          JSON_VALUE(data, '\$.type')          AS type,
          TIMESTAMP(JSON_VALUE(data, '\$.ts')) AS event_ts
        FROM \`${fq}.email_events_raw_latest\`
        WHERE operation != 'DELETE'
      " >/dev/null && echo "    ${dataset}.email_events_latest"
    else
      echo "    ⚠️  ${dataset}.email_events_raw_latest missing — deploy extensions first (skipping email_events_latest)"
    fi
  done
}

grant_dataset_viewer() { # <dataset> — dataset IAM via the access-entry method
  local dataset="$1" tmp
  tmp="$(mktemp)"
  bq --project_id="${PROJECT}" show --format=prettyjson "${PROJECT}:${dataset}" >"${tmp}"
  jq --arg sa "${RUNTIME_SA}" \
    '.access = ((.access // []) + [{"role":"roles/bigquery.dataViewer","userByEmail":$sa}] | unique)' \
    "${tmp}" >"${tmp}.new"
  bq update --source "${tmp}.new" "${PROJECT}:${dataset}" >/dev/null
  rm -f "${tmp}" "${tmp}.new"
}

iam() {
  echo "==> Granting least-privilege BigQuery roles to ${RUNTIME_SA}"
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/bigquery.jobUser" --condition=None >/dev/null
  echo "    + roles/bigquery.jobUser (project)"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    grant_dataset_viewer "${dataset}"
    echo "    + dataViewer on ${dataset} (dataset access entry)"
    if bq --project_id="${PROJECT}" show "${dataset}.widget_views" >/dev/null 2>&1; then
      bq add-iam-policy-binding --member="serviceAccount:${RUNTIME_SA}" \
        --role="roles/bigquery.dataEditor" "${PROJECT}:${dataset}.widget_views" >/dev/null
      echo "    + dataEditor on ${dataset}.widget_views (table)"
    else
      echo "    ⚠️  ${dataset}.widget_views missing — run ./setup.sh schema first (skipping dataEditor)"
    fi
  done
  cat <<EOF
    NOTE: also enable BigQuery Data Access audit logs (DATA_READ/DATA_WRITE) for
    ${PROJECT} — console: IAM & Admin > Audit Logs > BigQuery. (Left manual:
    editing auditConfigs via set-iam-policy is easy to get wrong.)
EOF
}

serviceaccounts() {
  # Least-privilege Eventarc invoker. Each firestore-bigquery-export function ALREADY runs as its
  # own dedicated per-instance SA (ext-fsbq-<instance>@, Firebase-managed, already holding its
  # dataset-scoped BigQuery roles). The ONLY gap is the invoker: the trigger's Pub-Sub PUSH
  # authenticates as the broad default compute SA, which also lacked run.invoker on the function's
  # Cloud Run service -> every push 403'd and nothing reached BigQuery. Fix: reuse each function's
  # OWN dedicated SA as the push identity — grant it run.invoker on its own service, let Pub-Sub
  # mint OIDC tokens as it, and override the push subscription's auth SA off the compute SA.
  #
  # The trigger destination is a gen2 Cloud Function, so `gcloud eventarc triggers update
  # --service-account` is REJECTED ("destination is neither cloud_function nor cloud_run_service").
  # We therefore set the identity on the trigger's Pub-Sub PUSH SUBSCRIPTION directly, and do NOT
  # touch the function runtime SA (Firebase manages it).
  # IDEMPOTENT — RE-RUN after any `firebase deploy --only extensions` (it recreates the trigger +
  # subscription, resetting the push auth SA back to the compute SA).
  local pn pubsub_agent
  pn="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
  pubsub_agent="service-${pn}@gcp-sa-pubsub.iam.gserviceaccount.com"

  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    for col in "${COLLECTIONS[@]}"; do
      local inst svc svcloc sa trig sub subid pe aud
      inst="$(instance_id "${col}" "${region}")"
      svc="ext-${inst}-fsexportbigquery"
      svcloc="$(gcloud run services list --project="${PROJECT}" \
        --filter="metadata.name=${svc}" \
        --format="value(metadata.labels['cloud.googleapis.com/location'])" | head -1)"
      if [ -z "${svcloc}" ]; then
        echo "    ⚠️  ${svc} not found — deploy extensions first (skipping ${inst})"
        continue
      fi

      # Reuse the function's OWN dedicated runtime SA as the invoker. Refuse if it is the shared
      # compute SA (we must NOT make that the invoker — investigate the install first).
      sa="$(gcloud run services describe "${svc}" --project="${PROJECT}" --region="${svcloc}" \
        --format='value(spec.template.spec.serviceAccountName)')"
      if [ -z "${sa}" ] || [[ "${sa}" == *-compute@developer.gserviceaccount.com ]]; then
        echo "    ⚠️  ${svc} runtime SA is '${sa:-unset}', not a dedicated ext-* SA — skipping."
        echo "        (Won't repoint the invoker onto the shared compute SA; investigate the install.)"
        continue
      fi
      echo "==> ${inst}: invoker = ${sa}"

      # 1. invoke path: this SA may invoke its own Cloud Run service (the missing grant -> 403).
      gcloud run services add-iam-policy-binding "${svc}" \
        --project="${PROJECT}" --region="${svcloc}" \
        --member="serviceAccount:${sa}" --role="roles/run.invoker" >/dev/null
      echo "    + run.invoker on ${svc} (${svcloc})"

      # 2. let Pub-Sub mint OIDC tokens AS this SA (so the push can present its identity).
      gcloud iam service-accounts add-iam-policy-binding "${sa}" --project="${PROJECT}" \
        --member="serviceAccount:${pubsub_agent}" \
        --role="roles/iam.serviceAccountTokenCreator" >/dev/null
      echo "    + tokenCreator for ${pubsub_agent} on ${sa}"

      # 3. override the push identity. Resolve the trigger (random suffix, in the DB location
      #    ${fsloc}) -> its Pub-Sub push subscription, then set the auth SA off the compute SA
      #    onto this SA (push endpoint + audience preserved).
      trig="$(gcloud eventarc triggers list --project="${PROJECT}" --location="${fsloc}" \
        --filter="name~${svc}" --format="value(name)" | head -1)"
      if [ -z "${trig}" ]; then
        echo "    ⚠️  no Eventarc trigger matching ${svc} in ${fsloc} (skipping invoker repoint)"
        continue
      fi
      sub="$(gcloud eventarc triggers describe "${trig}" --project="${PROJECT}" --location="${fsloc}" \
        --format='value(transport.pubsub.subscription)')"
      subid="${sub##*/}"
      pe="$(gcloud pubsub subscriptions describe "${subid}" --project="${PROJECT}" --format='value(pushConfig.pushEndpoint)')"
      aud="$(gcloud pubsub subscriptions describe "${subid}" --project="${PROJECT}" --format='value(pushConfig.oidcToken.audience)')"
      if [ -z "${pe}" ] || [ -z "${subid}" ]; then
        echo "    ⚠️  no push subscription/endpoint for ${trig} (skipping invoker repoint)"
        continue
      fi
      gcloud pubsub subscriptions update "${subid}" --project="${PROJECT}" \
        --push-endpoint="${pe}" --push-auth-service-account="${sa}" \
        --push-auth-token-audience="${aud}" >/dev/null
      echo "    + push-auth SA -> ${sa} on ${subid}"
    done
  done
  echo "    Done. Verify: no new 403s on ext-fsbq-* Cloud Run logs; ./setup.sh validate ${PROJECT}."
}

backfill() {
  echo "==> Backfilling existing rows (both collections x 3 regions) in ${PROJECT}"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    for col in "${COLLECTIONS[@]}"; do
      echo "    -> ${col} (DB ${db}) into ${dataset}.${col}_raw_changelog"
      # Capture output so a REAL failure (auth/permission) is surfaced loudly and
      # not masked as an empty-collection skip. An empty/absent collection (e.g.
      # email_events before any events, or a region with no signups) is the only
      # non-fatal case. (set -e is bypassed inside an `if` condition.)
      if out="$(npx -y @firebaseextensions/fs-bq-import-collection \
            --non-interactive \
            --project="${PROJECT}" \
            --source-collection-path="${col}" \
            --firestore-instance-id="${db}" \
            --dataset="${dataset}" \
            --dataset-location="${loc}" \
            --table-name-prefix="${col}" \
            --query-collection-group=false 2>&1)"; then
        echo "${out}" | grep -E "Finished importing" || echo "    (done: ${col}/${region})"
      elif echo "${out}" | grep -qiE "does not exist or is empty"; then
        echo "    (skipped ${col}/${region} — empty/absent collection; OK if no data yet)"
      else
        echo "    ⚠️  ${col}/${region} import FAILED (NOT an empty collection):"
        echo "${out}" | grep -iE "invalid_grant|reauth|denied|unauthenticated|error" | tail -2 | sed 's/^/         /'
        echo "       → if invalid_grant/reauth: run 'gcloud auth application-default login', then re-run backfill"
      fi
    done
  done
  echo "    Backfill complete. Run: ./setup.sh validate ${PROJECT}"
}

validate() {
  echo "==> BigQuery row counts in ${PROJECT} (compare against Firestore)"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    echo "  -- ${dataset} (${region}) --"
    if raw_latest_exists "${dataset}" "signups"; then
      bq --project_id="${PROJECT}" --location="${loc}" query --use_legacy_sql=false --format=pretty "
        SELECT 'signups_latest' AS tbl, COUNT(*) AS n FROM \`${PROJECT}.${dataset}.signups_latest\`
        UNION ALL
        SELECT 'email_events_latest', COUNT(*) FROM \`${PROJECT}.${dataset}.email_events_latest\`
      "
    else
      echo "    (views not created yet — deploy extensions + run ./setup.sh schema ${PROJECT})"
    fi
  done
  cat <<EOF
  Compare each signups_latest count against the Firestore total for that region
  (e.g. forTenant(ctx).signups.count(...) excluding deleted, summed across
  campaigns). They should match within the streaming/dedup window. Then flip:
  ANALYTICS_BQ_ENABLED + NEXT_PUBLIC_ANALYTICS_BQ_ENABLED = "true" in
  apphosting.<env>.yaml, and deploy.
EOF
}

verify() {
  echo "==> ${PROJECT} analytics datasets / tables / views"
  for spec in "${REGION_SPECS[@]}"; do
    read -r region db dataset loc fnloc fsloc <<<"$spec"
    echo "  -- ${dataset} (${region}, ${loc}) --"
    bq --project_id="${PROJECT}" ls "${dataset}" 2>/dev/null || echo "    (dataset missing — run ./setup.sh datasets ${PROJECT})"
  done
  echo "==> runtime SA project roles"
  gcloud projects get-iam-policy "${PROJECT}" \
    --flatten="bindings[].members" \
    --filter="bindings.members:${RUNTIME_SA} AND bindings.role:bigquery" \
    --format="table(bindings.role)" 2>/dev/null || true
}

case "${CMD}" in
  buildperms) buildperms ;;
  datasets)   datasets ;;
  extensions) extensions ;;
  schema)     schema ;;
  serviceaccounts) serviceaccounts ;;
  iam)        iam ;;
  backfill)   backfill ;;
  validate)   validate ;;
  verify)     verify ;;
  *)
    sed -n '2,40p' "$0"
    ;;
esac
