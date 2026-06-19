# Tamper-resistant audit trail — WORM audit-log bucket

This is the platform half of the launch-deletion audit trail. The application
writes an immutable record of every launch deletion; this bucket makes that
record **tamper-resistant** — append-only, retained 7 years, and beyond the reach
of the very service account that performs the deletions.

## Why this exists

Launch deletions are recorded to the Firestore `audit_events` collection for the
in-app view. But the Firebase Admin SDK bypasses Firestore Security Rules, and
Firestore IAM cannot be scoped per-collection — so the App Hosting runtime service
account that writes `campaigns`/`signups` can also **delete or rewrite**
`audit_events`. That copy can never be a tamper-proof system-of-record.

So the authoritative record is written **out of Firestore**, to a GCS bucket the
runtime SA cannot mutate.

## The two controls (either alone blocks tampering)

1. **Create-only IAM.** The runtime SA
   (`firebase-app-hosting-compute@<project>.iam.gserviceaccount.com`) gets
   `roles/storage.objectCreator` on this bucket — `storage.objects.create` only,
   *not* get/list/delete/overwrite. It can append a new audit object but can never
   read back, modify, or remove one.
2. **Locked retention policy (Bucket Lock).** A 7-year (`P2555D`) retention policy,
   once **locked**, is irreversible: no identity — not even project owner — can
   delete or shorten objects before they age out, nor delete the bucket while it
   holds objects. True WORM.

Each event is written create-only (`ifGenerationMatch: 0`) under a unique path
(`audit/launch-delete/<tenant>_<campaign>_<time>_<status>.json`), so there is
never an overwrite attempt and a retried write is an idempotent no-op. The bucket
is private (uniform bucket-level access + public-access-prevention enforced).

## SOC 2 mapping

- **CC6.x (least privilege / separation of duties):** create-only IAM; only a
  break-glass admin manages the bucket, and even they cannot violate the lock.
- **CC7.x (evidence integrity):** locked retention guarantees the trail outlives —
  and resists tampering by — the operators it audits.
- **Completeness:** the app writes an `initiated` record *before* the purge and a
  `completed`/`failed` record after, so a process that dies mid-purge still leaves
  a durable trail.

## Privacy / residency

Records are **PII-free** — actor identity, timestamp, campaign id/name, and
per-collection counts only; never the erased waitlist-member data. A single US
bucket per project therefore holds EU/Asia tenants' audit metadata too, consistent
with the existing US control-plane copy. (A per-region split is a future option if
residency policy tightens.)

## Runbook

```bash
# 1. Create bucket + retention + IAM (reversible). Dev first.
./setup.sh provision vizzybl-marketing-dev

# 2. Ensure AUDIT_LOG_BUCKET is set in apphosting.yaml and roll out (push to dev).

# 3. Delete a throwaway launch in the dev admin, then verify the object landed
#    and that the runtime SA cannot delete it.
./setup.sh verify vizzybl-marketing-dev

# 4. Lock retention — IRREVERSIBLE. Only after verification.
./setup.sh lock vizzybl-marketing-dev

# 5. Repeat 1–4 for prod (merge dev -> main rolls out apphosting.prod.yaml).
./setup.sh provision vizzybl-marketing-prod
# ... verify ... lock
```

**The lock is irreversible.** Do not run `lock` until `verify` shows audit objects
routing correctly. When `AUDIT_LOG_BUCKET` is unset (local dev / tests) the
application's audit sink is a no-op, so non-production environments need no bucket.
