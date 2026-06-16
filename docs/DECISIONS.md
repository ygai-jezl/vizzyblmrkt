# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0003 — Admin portal authentication (2026-06-15)

Context: building the admin portal (All Signups dashboard). Founder decisions:

- **Google Sign-In, restricted to the `@yougrow.ai` Workspace** (Google-only — no
  email/password in the UI). Verified via the Google `hd` hosted-domain claim,
  with an optional explicit `ADMIN_ALLOWED_EMAILS` allowlist for external accounts.
- **Claims bootstrap:** access is gated by `tenant_id`/`region`/`role` custom
  claims (a user cannot self-assign them). On first sign-in, an allowed account
  is granted admin on the bootstrap tenant (`ten_vzb`/`us`) via a two-step
  ID-token refresh (mint claims → refresh → session cookie). Per-tenant invites
  that assign claims explicitly are a later (org/RBAC) slice.
- **Session:** HttpOnly `__session` cookie (firebase-admin `createSessionCookie`),
  `verifySessionCookie(checkRevoked=true)`; tenant context derived ONLY from the
  verified claims, never from request input. The session/isolation layer is
  identical regardless of sign-in method.

Adversarial review (post-build) findings, all addressed:
- **P0 fixed:** the public web config (`NEXT_PUBLIC_FIREBASE_API_KEY` /
  `_AUTH_DOMAIN`) was never wired into App Hosting, so the deployed client shipped
  `apiKey:"emulator"` and every login failed. Now set in `apphosting.yaml` /
  `apphosting.prod.yaml` (public values, not secrets); the client fail-loud if the
  key is missing outside the emulator.
- **P2 fixed:** added a same-origin (Sec-Fetch-Site + Origin/host) guard on the
  admin mutation route (CSRF defense-in-depth on top of SameSite=Lax).
- **P2 (bounded, tracked):** the 5-day session cookie carries claims that
  `setCustomUserClaims` alone doesn't revoke. No impact today (both roles may
  manage signups; only NEW grants happen). Before shipping admin-only surfaces
  (org/billing), call `revokeRefreshTokens(uid)` on downgrade or re-read live
  claims for privileged actions.

---

## ADR-0002 — Regional data residency (2026-06-15)

Context: founder wants regional data residency (US / EU / Asia). Validated against
current Google docs — see [REGIONAL-DATA-RESIDENCY.md](./REGIONAL-DATA-RESIDENCY.md).
The sibling app `vizzybl-portal` already ships this named-database pattern in prod.

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Residency scope** | **Per tenant/brand** — each brand pinned to one region; all its campaigns + signups co-located. Keeps leaderboard/referrals/analytics single-database (the only cheap, atomic shape given no cross-database queries). |
| 2 | **What stays in-region** | **Data at rest only** — Firestore + BigQuery region-pinned; compute stays central (one US App Hosting backend reads all regional DBs) for the MVP. Full regional compute cells deferred until a latency SLA or in-transit/sovereignty requirement. |
| 3 | **Backend structure** | **Named Firestore databases in one project per env** — `(default)`=US (`nam5`), `signups-eu`=EU (`eur3`), `signups-asia`=Asia (`asia-southeast1`), one service account reaching all via `getFirestore(app, databaseId)`. Per-region BigQuery datasets. Not project-per-region. |

**Hard Google constraints baked into the design:**
- A Firestore database's **location is immutable** → `region` is set at tenant creation and never changes (enforced at the tenant write path in Phase 1). This is why `region` is front-loaded into Phase 0.
- **No Asia multi-region** — only US (`nam5`/`nam7`) and EU (`eur3`). Asia is single-region (`asia-southeast1`, ≥99.99% SLA vs ≥99.999% for US/EU).
- **No cross-database / cross-location queries.** Per-tenant residency keeps each campaign in one DB so this never bites the leaderboard.
- **Only one free database per project**; EU/Asia DBs bill from op #1 (Blaze required).
- `getFirestore(app, databaseId)` carries a stale "preview" banner but is GA and proven in the sibling prod app; `db.settings({ databaseId })` does NOT work.

**Control-plane / data-plane split:**
- Control plane = `(default)` DB: `tenants` + `tenant_users` registry (routing/membership metadata, no end-user PII). Read first to resolve `host → tenant → region`.
- Data plane = regional DBs: `campaigns` + `signups` (the PII), in the tenant's region.

**Implemented in Phase 0 (region-ready, all three databases provisioned in dev):** `Region` enum + immutable `region` on the tenant schema; `src/lib/tenant/region.ts` (`REGION_CONFIGS` + non-defaulting `databaseIdForRegion`); parameterized `getDb(databaseId)` with per-id cache; `region` on `TenantContext`/claims; `forTenant(ctx)` routes campaigns/signups to the regional DB and `tenant_users` to the control plane, and **throws if `region` is absent**.

**Founder decisions — RESOLVED (2026-06-15):**
- **Asia region = `asia-southeast1` (Singapore)** (immutable; matches the sibling app and the `gcp.resourceLocations` allow-list).
- **EU = `eur3`** multi-region (5-nines, in-EU).
- **Sovereignty = no** — residency only. Data-at-rest in-region + the `gcp.resourceLocations` org policy is sufficient. Assured Workloads / CMEK deferred unless a contract demands it.
- **Provisioning:** all three regional databases now exist in **dev** (verified): `(default)`@`nam5` (US), `signups-eu`@`eur3` (EU), `signups-asia`@`asia-southeast1` (Asia). `region.ts` has all three `provisioned: true`; `firebase.json` lists all three so `firebase deploy --only firestore` pushes the deny-all rules + composite indexes to each. (Prod: provision the EU/Asia databases there before routing an EU/Asia tenant.) See [[gcp-dev-provisioning]] for the live project IDs, App Hosting backends, and org policies.

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

### Known limitation — self-referral (Phase 2, accept for now)
The referral engine credits one referral per signup *document*. A determined
user can still self-refer by signing up a second time with a different contact
(`a+1@x.com`, or email-vs-phone on an `EITHER` campaign) using their own link.
Truly closing this needs identity/verification — it's deferred to the **double
opt-in** slice (and reCAPTCHA, currently flagged off). The
`referrerToken === newSignupToken` guard in `creditReferral` is cheap
defense-in-depth only (the new token is always freshly generated). Tracked, not
fixed in Phase 2 slice 1. The leaderboard ranks by `amountReferred` (not the
spots-weighted score) so it stays correct even when `spotsToMoveUponReferral` is 0.

### Open items carried forward
- Confirm exact per-field PII masking spec for the public leaderboard (Phase 2).
- Confirm leaderboard freshness tolerance (enables CDN/rollup caching vs live count).
- BigQuery PII-erasure SLA (a Firestore delete does not erase the BigQuery copy).
- **Embeddable widget — per-tenant `frame-ancestors` (deferred 2026-06-16; shipped open).** The widget (`/embed/*`, `/embed.js`) ships with `Content-Security-Policy: frame-ancestors *` and `X-Frame-Options` dropped for that route only (all other routes stay `frame-ancestors 'none'`) — so any site can embed the widget today. Acceptable for MVP: the embed exposes only what `/waitlist/<id>` already serves publicly, and the write path is guarded by reCAPTCHA + double opt-in (worst case is mild signup-form clickjacking, which double opt-in neutralizes). **To do later (gated on real third-party tenants):** restrict each tenant's widget to an approved embed allowlist. Notes for whoever picks this up: (1) this is NOT the same as `tenant.allowedOrigins` — those are the tenant's own Host-routing domains, whereas embed ancestors are the *parent sites* permitted to frame the widget; add a dedicated field (e.g. `campaign.embedAllowedAncestors` or tenant-level). (2) `next.config.ts` `headers()` is static and can't read Firestore per-request, so this needs Node-runtime middleware (firebase-admin is Node-only) or an edge-readable cache of each tenant's allowed ancestors. See `next.config.ts` (`/embed/:path*` header block) and SETUP §12.
