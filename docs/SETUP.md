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

### 3b. Regional data residency — the three named databases
All three regional databases are created in **dev** (`firebase.json` lists all
three; `region.ts` has them `provisioned: true`). Location is **immutable** and
there is **no Asia multi-region**:
```bash
# EU (multi-region eur3):
gcloud firestore databases create --project="$PROJECT" --database=signups-eu   --location=eur3
# Asia (single region — Singapore):
gcloud firestore databases create --project="$PROJECT" --database=signups-asia --location=asia-southeast1
```
`firebase deploy --only firestore` pushes the deny-all rules + composite indexes
to **all** databases listed in `firebase.json`. **Repeat the database creation in
PROD** before routing an EU/Asia tenant there. Per-region
`firestore-bigquery-export` → same-region BigQuery dataset is Phase 2.
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

## 8. Identity Platform + admin portal auth — Google Sign-In (Phase 2)
The admin portal signs in with **Google** (restricted to the `@yougrow.ai`
Workspace) and exchanges the ID token for an HttpOnly session cookie. On first
sign-in the server mints the `tenant_id` / `region` / `role` claims (no manual
user creation). Steps for the **deployed** portal (local dev uses the Auth
emulator — no console setup needed):

1. **Enable Identity Platform** (console → Identity Platform → Get started) and
   turn on the **Google** provider. Add your App Hosting domains to the
   authorized domains. (You can leave Email/Password disabled.)
2. **Web config is already wired** into `apphosting.yaml` / `apphosting.prod.yaml`
   (`NEXT_PUBLIC_FIREBASE_API_KEY` + `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` — public,
   not secrets). Verify they match each project's Web app.
3. **Access control** is env-driven (already set in the yaml defaults):
   `ADMIN_ALLOWED_DOMAINS=yougrow.ai` (+ optional `ADMIN_ALLOWED_EMAILS`),
   `NEXT_PUBLIC_ADMIN_HD=yougrow.ai`, and the bootstrap target
   `ADMIN_BOOTSTRAP_TENANT_ID=ten_vzb` / `ADMIN_BOOTSTRAP_REGION=us`. Any
   `@yougrow.ai` account that signs in is granted admin on the bootstrap tenant.
4. **First real prod tenant:** before admins sign in on prod, create the real
   `vizzybl.ai` tenant + campaign (a proper first-tenant flow, not the demo seed).

> Local dev: `npm run smoke` seeds `admin@yougrow.ai` / `vizzybl-demo-pass` into
> the Auth emulator with the right claims, exercising the full
> sign-in → dashboard → offboard flow without any console setup. Real users never
> use a password — the login UI is Google-only.

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

## 11. Firestore → BigQuery analytics pipeline (data lake, for scale)
The admin Analytics dashboard reads Firestore directly (real-time, exact, cheap
at MVP scale). For full-scale / heavy analytics, stream signups into BigQuery
with the **Stream Firestore to BigQuery** extension — **one instance + dataset
per region** (so data stays in-region; requires Blaze, which we're on):
```bash
# US (default DB → US dataset). Repeat per region with its DB id + a same-region
# dataset location (eu → eur3 → EU; asia → signups-asia → asia-southeast1).
firebase ext:install firebase/firestore-bigquery-export --project="$PROJECT"
#   COLLECTION_PATH=signups
#   DATASET_ID=waitlist_us           (eu: waitlist_eu, asia: waitlist_asia)
#   DATASET_LOCATION=US              (eu: EU, asia: asia-southeast1)
#   DATABASE=(default)               (eu: signups-eu, asia: signups-asia)
#   TABLE_ID=signups
#   WILDCARD_IDS / schema views as needed for the answers map + utm fields
```
Then run an initial backfill (`fs-bq-import-collection`) for existing rows. The
extension writes an append-only changelog (CREATE/UPDATE/DELETE) + a latest view;
query the latest view, partition by date, cluster by tenantId, and enforce
per-tenant isolation via authorized views / RLS. To move the dashboard onto it,
implement `computeCampaignAnalytics`'s contract against BigQuery (the KPI shape
is the seam). See docs/ARCHITECTURE-AND-DELIVERY.md §7 + VALIDATION-FINDINGS.md.

---

## 12. Embeddable widget (drop the waitlist on any site)
The waitlist can be embedded on any external site as a self-resizing iframe — no
build step or framework on the host page. Founders generate the snippet in the
admin **Widget** tab (`/admin/widget`): pick a campaign + widget type, preview it
live, and copy. The snippet is:
```html
<!-- Vizzybl waitlist widget -->
<div data-vizzybl-campaign="beta-launch" data-vizzybl-type="WIDGET_1"></div>
<script src="https://<your-app-origin>/embed.js" async></script>
```
- **Widget types:** `WIDGET_1` (full form), `WIDGET_2` (mini, email-only inline),
  `WIDGET_3` (docked, email-only with the button inside the field).
- **How it works:** `/embed.js` turns each `[data-vizzybl-campaign]` div into a
  cross-origin iframe of `/embed/<campaign>` on the app origin, and keeps it
  sized to its content via origin-checked `postMessage`. Because the iframe is
  served from our origin, tenant resolution (by host) + the signup API + reCAPTCHA
  all work same-origin inside the frame — **no CORS or cross-origin-tenant work**.
- **Optional attributes:** `data-vizzybl-mode="CHECK"`, `data-vizzybl-ref="<token>"`
  (passes a referral token through, so embeds stay viral),
  `data-vizzybl-button-color` / `-bg-color` / `-font-color` (hex only — validated
  server-side as a CSS-injection guard), `data-vizzybl-height` (fixed height,
  disables auto-resize).
- **Host-page hook:** on a successful signup the loader dispatches a
  `vizzybl:signup` event on the host `window` (detail: `alreadyJoined`,
  `needsVerification`, `totalSignups`) for analytics/redirects.
- **Framing/security:** the `/embed/*` route sets `Content-Security-Policy:
  frame-ancestors *` and drops `X-Frame-Options` (in `next.config.ts`) so it can
  be framed anywhere; every other route stays `frame-ancestors 'none'`. The embed
  exposes only what is already public on `/waitlist/<id>`, and the write path is
  guarded by reCAPTCHA + double opt-in. **Future hardening:** scope
  `frame-ancestors` to each tenant's `allowedOrigins`.

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
