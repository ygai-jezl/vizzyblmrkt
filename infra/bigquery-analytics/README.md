# BigQuery hybrid-analytics provisioning

Provisions the GCP side of the Phase-2 hybrid analytics pipeline. The app code
(`src/lib/analytics/bigquery.ts`, the `/api/track/view` beacon, the hybrid seams
in `analytics.ts`/`email.ts`) is already deployed but **inert** —
`ANALYTICS_BQ_ENABLED="false"` in `apphosting.yaml` / `apphosting.prod.yaml`.
Until you provision this and flip the flag, the dashboard stays on Firestore.

See `docs/SETUP.md §11` for the design and `setup.sh` (top comment) for details.

## What it creates (per project, per region us/eu/asia)

- **3 BigQuery datasets** — `waitlist_us` (US), `waitlist_eu` (EU),
  `waitlist_asia` (asia-southeast1). Same-region as each Firestore DB so PII
  stays in-region (no cross-region JOINs — only de-identified aggregates may
  ever cross, deferred).
- **6 `firestore-bigquery-export` instances** — `signups` + `email_events`,
  each × 3 regions. Each writes a `<col>_raw_changelog` + `<col>_raw_latest`.
- **Typed views** `signups_latest` + `email_events_latest` per dataset (the BQ
  code queries these; they `JSON_VALUE`-extract from the raw `data` column).
- **`widget_views` table** per dataset (app-owned, PII-free, partitioned by
  `ingest_day`, clustered by `tenant_id,campaign_id`) — written by the beacon.
- **IAM** on the App Hosting runtime SA: `bigquery.jobUser` (project) +
  dataset-scoped `dataViewer` + `dataEditor` on each `widget_views` table.
- **3 dedicated export SAs** `fsbq-export-{us,eu,asia}@<project>` (`serviceaccounts`
  step) — each is the Eventarc invoker **and** the function runtime for its region's
  2 instances, replacing the broad default compute SA. Least-privilege: `run.invoker`
  on only its 2 services, dataset-scoped `dataEditor` on only `waitlist_<r>`, plus
  project `eventarc.eventReceiver` + `bigquery.jobUser`.

## Run order (DEV first → validate → PROD)

Run the steps **one at a time** — the extension deploy must finish before
`schema`/`backfill`/`validate` (they need the `*_raw_latest` views the extensions
create). `extensions` writes the `.env` files to the **repo-root** `extensions/`
and registers the 6 instances in the repo-root `firebase.json` automatically.

```bash
cd infra/bigquery-analytics
./setup.sh datasets   vizzybl-marketing-dev
./setup.sh extensions vizzybl-marketing-dev
# deploy from the repo root (where firebase.json lives); may prompt to enable
# APIs + accept the extension IAM, and provisions 6 Cloud Functions (~minutes):
( cd ../.. && firebase deploy --only extensions --project=vizzybl-marketing-dev )
./setup.sh schema     vizzybl-marketing-dev
./setup.sh serviceaccounts vizzybl-marketing-dev
./setup.sh iam        vizzybl-marketing-dev
./setup.sh backfill   vizzybl-marketing-dev
./setup.sh validate   vizzybl-marketing-dev
```

Then **flip the flag** for the env and deploy:

```yaml
# apphosting.yaml (dev) / apphosting.prod.yaml (prod)
- variable: ANALYTICS_BQ_ENABLED            { value: "true" }
- variable: NEXT_PUBLIC_ANALYTICS_BQ_ENABLED { value: "true" }
```

Commit + push the live branch (dev branch → dev, `main` → prod). Re-run the
whole sequence with `vizzybl-marketing-prod` once dev is validated.

## Gotchas

- **Extension param keys drift between versions.** If `firebase deploy --only
  extensions` rejects a key in a `.env`, run `firebase ext:install
  firebase/firestore-bigquery-export` once interactively to confirm the current
  names, then fix the `.env` files.
- **Trigger LOCATION must sit inside the source DB's location** (nam5 →
  `us-central1`, eur3 → `europe-west4`, asia-southeast1 → `asia-southeast1`),
  or Eventarc delivery silently fails.
- `schema` depends on the extensions having created `<col>_raw_latest` — run it
  **after** the extension deploy (the view exists at install, before any data).
- **Eventarc push 403 → no data reaches BigQuery.** The extension's trigger runs as
  the default compute SA, which Firebase does **not** reliably grant `run.invoker` on
  the function's Cloud Run service, so every push silently 403s. `serviceaccounts`
  fixes this by repointing the trigger + runtime onto the dedicated per-region SAs and
  granting them `run.invoker`. **Re-run `./setup.sh serviceaccounts <project>` after
  any `firebase deploy --only extensions`** — the deploy can reset the trigger/runtime
  SA back to the compute SA (the extension exposes no SA param). Symptom of regression:
  403s in the `ext-fsbq-*` Cloud Run request logs + BigQuery tables stop growing.
- **Audit logs** (BigQuery DATA_READ/DATA_WRITE) are left as a deliberate manual
  step — see `iam`'s note.
- **PII erasure**: a Firestore signup delete does not erase the BQ changelog
  copy. `signups_latest` filters deletes out, but define a purge SLA for EU
  tenants if GDPR erasure is in scope.
