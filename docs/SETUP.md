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
```bash
gcloud firestore databases create --project="$PROJECT" --location=nam5   # pick your region

firebase use "$PROJECT"
firebase deploy --only firestore:rules,firestore:indexes
```
- `firestore.rules` is a deny-all backstop (server access bypasses rules; isolation is in app code).
- `firestore.indexes.json` pre-creates the tenant-scoped composite indexes.

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

## 5. Org policies **(org)** — close the common misconfig holes
```bash
gcloud resource-manager org-policies enable-enforce \
  iam.disableServiceAccountKeyCreation --project="$PROJECT"
gcloud resource-manager org-policies enable-enforce \
  iam.automaticIamGrantsForDefaultServiceAccounts --project="$PROJECT"
```

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
