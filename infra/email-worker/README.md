# Scheduled email-delivery worker

The journey/broadcast engine writes due sends into the tenant-scoped Firestore
`email_jobs` queue ([src/lib/email/delivery.ts](../../src/lib/email/delivery.ts)).
Firebase App Hosting has **no built-in cron**, so without an external trigger the
queue is never drained — journey steps enqueue and sit forever. (The double-opt-in
verification email is unaffected: it is sent inline at signup, not via the queue.)

This wires a **Cloud Scheduler** job that drains the queue on a cadence:

```
Cloud Scheduler ──(POST + X-Worker-Secret)──▶ /api/admin/email/jobs/process
                                              └▶ processEmailJobsForAllTenants()
                                                 drains EVERY tenant, ALL regions (US/EU/Asia)
```

The worker endpoint authenticates the machine caller by a shared secret:

- stored in Secret Manager as `email-worker-secret`;
- read by the app as `EMAIL_WORKER_SECRET` (wired in `apphosting.<env>.yaml`);
- set as the scheduler request header `X-Worker-Secret`.

Both sides must be non-empty and equal — an unset secret can never authenticate
an empty header (it falls through to the admin-session path instead). A logged-in
admin can still POST the same endpoint to drain **their own** tenant on demand.

## Provisioning order

```bash
# 1) create the secret + grant the runtime SA (reversible)
infra/email-worker/setup.sh secret vizzybl-marketing-prod

# 2) the secret reference is already uncommented in apphosting.prod.yaml.
#    DEPLOY the app so EMAIL_WORKER_SECRET resolves (deploy must come AFTER step 1,
#    or the rollout fails resolving the secret).

# 3) start the cron (reads the live secret value for the header)
infra/email-worker/setup.sh scheduler vizzybl-marketing-prod

# 4) confirm
infra/email-worker/setup.sh verify vizzybl-marketing-prod
infra/email-worker/setup.sh run    vizzybl-marketing-prod   # one-off smoke test
```

## Defaults (edit in `setup.sh`)

| Setting    | Value                                            |
| ---------- | ------------------------------------------------ |
| Job        | `email-delivery-worker`                          |
| Location   | `us-central1` (HTTP trigger only — not a data-residency boundary; adjust for the `gcp.resourceLocations` org policy if needed) |
| Schedule   | `*/2 * * * *` (every 2 min, due jobs only)        |
| Target     | prod → `https://yougrow.ai/api/admin/email/jobs/process` |

The endpoint is host-agnostic for the secret caller (it fans out to all tenants
regardless of which host it is reached on), so the canonical platform origin is
used as the target.

## Troubleshooting

- **Steps not sending, queue growing**: `setup.sh verify` — no job, or `state`
  not `ENABLED`, means nothing is draining. Check App Hosting logs for the
  `[delivery]` per-tenant lines.
- **401 from the endpoint**: the header value ≠ the deployed `EMAIL_WORKER_SECRET`
  (re-run `scheduler` after rotating the secret), or the app wasn't redeployed
  after the secret was created.
- **One region stuck**: `processEmailJobsForAllTenants` isolates per-tenant
  failures — a tenant in an unprovisioned region is logged (`[delivery] tenant …
  drain failed`) and skipped; the others still drain.
