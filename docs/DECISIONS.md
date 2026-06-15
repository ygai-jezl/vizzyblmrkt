# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0001 — MVP runtime, security posture, tenancy & scoring (2026-06-15)

Context: kickoff. PRD validated against current Google Cloud docs (see
[ARCHITECTURE-AND-DELIVERY.md](./ARCHITECTURE-AND-DELIVERY.md) and
[VALIDATION-FINDINGS.md](./VALIDATION-FINDINGS.md)). Four decisions confirmed
with the founder:

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | **Edge security at MVP** | **Firebase App Hosting + app-layer reCAPTCHA Enterprise + App Check** (no edge Cloud Armor yet) | App Hosting already runs behind a Google-managed LB/CDN you can't attach Cloud Armor to. App-layer `createAssessment` uses the *same* reCAPTCHA risk engine. Edge WAF mainly adds pre-compute volumetric absorption + SQLi/XSS rules — low value on a Firestore (no-SQL) MVP. If a public endpoint is later attacked, peel just that route onto raw Cloud Run + Cloud Armor. |
| 2 | **VPC-SC perimeter / CMEK** | **Defer** — no compliance driver yet | Data is encrypted at rest by default. Keep the design VPC-SC-*ready* (Direct VPC egress, scoped SAs) so the upgrade is non-breaking. Revisit on first enterprise/SOC2/GDPR driver. |
| 3 | **Tenant isolation enforcement** | **Application code**, via the centralized `forTenant(ctx)` repository | Firestore Security Rules do NOT protect server-side (service-account) access. Rules are kept as a deny-all backstop. `tenantId` is always derived server-side (host→tenant map or verified `tenant_id` claim), never from a request body. |
| 4 | **Leaderboard scoring** | Per-campaign **`spotsToMoveUponReferral`** (admin-editable integer); `score = amountReferred × spotsToMoveUponReferral`; ties broken by `createdAt ASC` | Honours the founder's "spots skipped per referral" model. `score` stays a small pure integer — we deliberately do NOT fold the Unix timestamp into it (avoids the seconds-vs-ms precision bug and a magic constant). Exact position/leaderboard math is finalized in Phase 2. Time is always integer Unix **seconds**. |

### Runtime / stack
- **Next.js 15 + React 18 + TypeScript 5.6**, Tailwind, Zod, Vitest — aligned with the sibling app `vizzybl-portal`.
- Deploy on **Firebase App Hosting**; two projects: `vizzybl-marketing-dev` and `vizzybl-marketing-prod`. Prod uses `minInstances: 1`.
- Firestore accessed via `firebase-admin` (Application Default Credentials; no key files). `firestore-bigquery-export` extension on a **Blaze** project for the analytics pipeline (Phase 2) — the BigQuery *sandbox* cannot stream.

### Data model (from `Vizzybl-Marketing Data Schema.md`)
Root-level collections, all partitioned by `tenantId`:
- `tenants` (global registry — not tenant-scoped; resolved by id / allow-listed origin)
- `tenant_users` (flat user↔tenant associations; role `admin` | `member`)
- `campaigns` (one per waitlist; holds `spotsToMoveUponReferral`, questions, styling)
- `signups` (waitlist members; identity, state flags, referral mechanics, `score`, `answers`, `metadata`)

### Deviations from the provided schema (intentional)
- **`score` semantics:** the schema's example value looked like a folded
  `referrals*K − timestamp`. We store `score = amountReferred × spotsToMoveUponReferral`
  (pure integer) and tie-break by `createdAt` via the composite index
  `(tenantId, campaignId, status, score DESC, createdAt ASC)`. See decision #4.

### Canonical leaderboard query (fixes the index design)
The public leaderboard query is **always status-filtered** to active members:
`where tenantId == X and campaignId == Y and status == 'verified_active' order by score DESC, createdAt ASC`.
This is served by the composite index
`(tenantId, campaignId, status, score DESC, createdAt ASC)` in
`firestore.indexes.json`. No status-less leaderboard index is created (offboarded
/ deleted members never appear on the public board). **Phase 1 TODO:** add a
Firestore-emulator integration test to CI — the emulator enforces composite
indexes, which the in-memory fake cannot, so missing-index regressions need the
emulator to catch.

### Post-review hardening (2026-06-15, from the adversarial isolation review)
- **P0 fixed:** `TenantCollection.create()` now uses Firestore's atomic
  `create()` (rejects if the id exists in *any* tenant) instead of `set()`,
  closing a cross-tenant overwrite/hijack via a guessed id. Regression tests added.
- **P1 fixed:** `next` pinned to `^15.5.7` (CVE-2025-55182 / App Hosting adapter
  block); ESLint isolation rule hardened against computed access,
  transaction/batch/doc/getAll, and bare client-SDK calls, and now bans
  `firebase/firestore` + `@google-cloud/firestore` imports; the test fake now
  models `ignoreUndefinedProperties` and Firestore's missing-sort-field
  exclusion. Lint runs via the ESLint CLI (not the deprecated `next lint`).

### Open items carried forward
- Confirm exact per-field PII masking spec for the public leaderboard (Phase 2).
- Confirm leaderboard freshness tolerance (enables CDN/rollup caching vs live count).
- BigQuery PII-erasure SLA (a Firestore delete does not erase the BigQuery copy).
- Embeddable widget will need a per-tenant `frame-ancestors` CSP derived from `allowedOrigins` (overrides the global `X-Frame-Options: DENY`).
