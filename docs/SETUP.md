# vizzybl-marketing — GCP / Firebase Setup Checklist (Phase 0)

These are the cloud-side steps to run **once** to stand up the foundations.
Commands are provided so you can run them yourself (the agent does not have
authority to create or modify your GCP resources). Run them in order. Steps
marked **(org)** require Organization-level permissions and can be skipped if
this is a standalone project — but they are strongly recommended.

> Two projects: `vizzybl-marketing-dev` and `vizzybl-marketing-prod`. Do the
> whole list for **dev** first, verify, then repeat for **prod**.

---

## 0. Prerequisites
```bash
gcloud --version          # Google Cloud SDK
firebase --version        # >= 13
node -v                   # >= 20
gcloud auth login
```

## 1. Create the project & link Blaze billing
The analytics pipeline (Firestore→BigQuery extension) streams, and **streaming
requires a billing-enabled (Blaze) project — the BigQuery sandbox cannot stream.**
```bash
export PROJECT=vizzybl-marketing-dev          # then repeat with -prod
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX    # gcloud billing accounts list

gcloud projects create "$PROJECT"
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
firebase projects:addfirebase "$PROJECT"
```

## 2. Enable APIs
```bash
gcloud services enable --project="$PROJECT" \
  firestore.googleapis.com \
  firebaseapphosting.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  recaptchaenterprise.googleapis.com \
  identitytoolkit.googleapis.com \
  eventarc.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  bigquery.googleapis.com \
  cloudbilling.googleapis.com \
  pubsub.googleapis.com
```

## 3. Firestore (Native mode) + rules + indexes
The `(default)` database is BOTH the control plane (the `tenants`/`tenant_users`
registry) and the US data plane. Provision it in the US multi-region (`nam5`):
```bash
gcloud firestore databases create --project="$PROJECT" --location=nam5

firebase use "$PROJECT"
firebase deploy --only firestore   # deploys rules + indexes to every DB in firebase.json
```
- `firestore.rules` is a deny-all backstop (server access bypasses rules; isolation is in app code).
- `firestore.indexes.json` pre-creates the tenant-scoped composite indexes.

### 3b. Regional data residency — additional databases (when needed)
Only the US (`(default)`) database is provisioned at MVP. When an EU or Asia
tenant arrives, create that region's NAMED database (location is **immutable** —
choose carefully; there is **no Asia multi-region**):
```bash
# EU (multi-region eur3):
gcloud firestore databases create --project="$PROJECT" --database=signups-eu   --location=eur3
# Asia (single region — Singapore; or asia-northeast1 Tokyo / asia-south1 Mumbai):
gcloud firestore databases create --project="$PROJECT" --database=signups-asia --location=asia-southeast1
```
Then: (a) add a `{ "database": "signups-eu", "rules": ..., "indexes": ... }` entry
to `firebase.json` and `firebase deploy --only firestore`; (b) flip `provisioned: true`
for that region in `src/lib/tenant/region.ts`; (c) stand up a same-region
`firestore-bigquery-export` instance → same-region BigQuery dataset (Phase 2).
Each extra database bills from op #1 (Blaze required — only one DB is free).

## 4. Least-privilege service accounts
App Hosting runs each backend under a runtime service account. Grant it only
what it needs (no `Owner`, no broad roles):
```bash
# App Hosting creates `firebase-app-hosting-compute@$PROJECT.iam.gserviceaccount.com`
# on first backend deploy. After that, scope it:
export SA="firebase-app-hosting-compute@$PROJECT.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/recaptchaenterprise.agent"
# Phase 2 async workers: roles/cloudtasks.enqueuer
```

## 5. Org policies **(org)** — close the common misconfig holes + enforce residency
```bash
gcloud resource-manager org-policies enable-enforce \
  iam.disableServiceAccountKeyCreation --project="$PROJECT"
gcloud resource-manager org-policies enable-enforce \
  iam.automaticIamGrantsForDefaultServiceAccounts --project="$PROJECT"
```
**Data-residency enforcement** — `gcp.resourceLocations` blocks creating any
resource (Firestore, BigQuery, Functions, Storage) outside the allow-listed
regions. Set it **before provisioning anything**; it applies to newly-created
resources only. Use value groups so in-boundary regions aren't accidentally
excluded. Example allowing US + EU + Singapore:
```bash
cat > /tmp/resource-locations.yaml <<'YAML'
constraint: constraints/gcp.resourceLocations
listPolicy:
  allowedValues:
    - in:us-locations
    - in:eu-locations
    - in:asia-southeast1-locations
YAML
gcloud resource-manager org-policies set-policy /tmp/resource-locations.yaml --project="$PROJECT"
```
> Note: this is an enforcement guardrail, not the contractual data-storage
> commitment (that lives in Google's Service Specific Terms). Assured Workloads /
> CMEK are only needed for **sovereignty**, not basic residency — deferred.

## 6. Budget alerts + billing kill-switch
Public, unauthenticated endpoints can drive unbounded spend; **budget alerts do
not cap spending.** Create a budget that publishes to Pub/Sub, plus a Cloud
Function that disables billing past a hard ceiling.
```bash
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="vizzybl-marketing-dev cap" \
  --budget-amount=50USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```
Then deploy the kill-switch function (see
https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage).

## 7. reCAPTCHA Enterprise key (Phase 1)
```bash
gcloud recaptcha keys create --project="$PROJECT" \
  --display-name="waitlist-web" --web --integration-type=score \
  --domains=localhost --domains=vizzybl.ai
```
Put the **site key** in `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`. The server-side
assessment uses ADC — no secret key in `NEXT_PUBLIC_*`.

## 8. Identity Platform multi-tenancy (Phase 1, admin portal)
Enable Identity Platform, turn on multi-tenancy (GCIP), and enable Email
Enumeration Protection. Create a tenant per brand; mint `tenant_id` + `role`
custom claims on users. (Console: Identity Platform → Settings → Security.)

## 9. App Hosting backend + connect repo
```bash
firebase apphosting:backends:create --project="$PROJECT" --location=us-central1
# Connect your GitHub repo; set the live branch (main → prod, a dev branch → dev).
# Bind the prod backend to the `prod` environment so apphosting.prod.yaml applies.
```

## 10. Secrets
```bash
firebase apphosting:secrets:set recaptcha-api-key --project="$PROJECT"
# then uncomment the matching block in apphosting.yaml
```

---

## Local development
```bash
cp .env.example .env.local        # fill in values / point at the emulator
npm install
npm run emulators                 # Firestore + Auth emulators
# in another shell:
npm run dev                       # http://localhost:3002
```
Set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` in `.env.local` to route the admin
SDK at the local emulator (no cloud credentials needed for local work).

## Deferred to later phases (do NOT set up now)
VPC Service Controls perimeter, internal-only Cloud Run, a self-managed external
ALB + Cloud Armor, Vertex AI Agent Engine / Agent Identity / A2A, and the
Firestore→BigQuery extension (Phase 2). See ARCHITECTURE-AND-DELIVERY.md §3.
