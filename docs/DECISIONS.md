# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0006 · Connector security fixes (2026-11-20)

Context: a security review on 17 Nov found these still true for connected accounts
(GitHub, GitLab, X, LinkedIn, LinkedIn Pages) and Mailchimp settings:
- any member of a brand could connect, disconnect or pick repos, and change the brand's
  Mailchimp settings;
- GitLab connections died 2 hours after connecting, because GitLab's refresh token was
  never stored;
- GitHub and GitLab sign-in were not bound to the browser that started them (X and
  LinkedIn already were);
- Disconnect never cancelled anything at the provider.

Reviewing the fixes found four more:
- a brand could claim the shared Mailchimp audience, or another brand's, and so receive
  their unsubscribes, bounces and spam reports;
- disconnecting an X account deleted its `social_subscriptions` row even when another
  brand held it, which wiped that brand's X attribution;
- a token refresh during a publish run wrote the whole connection back, so it could
  bring back an account someone had just disconnected;
- `setTenantGitRepos` wrote onto a connection that a racing Disconnect had removed,
  leaving a partial map the tenant schema rejects, which locked everyone out of the brand.

Decision (one PR, three groups of commits):
- **Admins only.** Connecting, disconnecting, picking repos and changing Mailchimp
  settings need the admin role. Every route under `/api/admin/integrations` goes through
  `src/lib/integrations/admin.ts`: `integrationsAdmin` (origin check, sign-in, then the
  role for anything that changes state) and `integrationsHopAdmin` for the OAuth start
  and callback hops. `src/lib/integrations/routesGate.test.ts` fails when a route skips
  it. The Mailchimp settings `PUT` checks the role in its own route. Members still see
  what is connected, read only, and are told to ask an admin.
- **Sign-in bound to the browser.** Every OAuth hop carries a nonce in its signed state
  that must match a cookie the start set. GitHub (App install and classic OAuth) and
  GitLab now use `git_oauth_state`: httpOnly, SameSite lax, Secure on https, 10 minutes,
  scoped to that provider's callback path. A missing or different cookie goes back with
  `bad_state` before any code exchange. X and LinkedIn already worked this way.
- **Mailchimp only tightens.** A brand can turn `requiresOwnApiKey` on, never off. A new
  audience id is refused when it is the shared audience, another brand holds it (the
  answer never names that brand), the brand has no key of its own, or that key can't
  read the list. Nothing is saved on a refusal, and an unchanged id is not checked again.
- **X attribution.** `deleteTenantSocialConnection` is one transaction that deletes
  `social_subscriptions/{platform}:{userId}` only when this brand is its holder.
- **GitLab stays connected.** The GitLab callback stores the refresh token, sealed with
  AAD `<tenantId>:gitlab:refresh` (`gitRefreshAad`, the pattern of the Mailchimp key
  box), and its expiry. The access token keeps no AAD because the knowledge worker opens
  it. Only the app refreshes, before every use (`src/lib/integrations/tokenRefresh.ts`);
  the worker is unchanged. Before a worker trigger (knowledge ingest, Learn from repo)
  the token must have 90 minutes left: the Job has a 60 minute task timeout and one
  retry, so a retry clones at most about 60 minutes after the trigger and still has 30
  minutes in hand. Every write is compare-and-set on the access token it replaces
  (`swapTenantGitToken`, `markTenantGitReconnect`, `clearTenantGitReconnect`), so
  overlapping refreshes settle on one token and a slower request never marks a
  connection another request has just refreshed. `setTenantGitRepos` is a transaction
  that writes nothing when the connection is gone.
- **The reconnect line.** "This connection needs reconnecting." shows when a refresh was
  refused, the provider rejected the token, an older GitLab connection with no refresh
  token is over 2 hours old, or a social token has expired with no refresh token. Admins
  get Reconnect, which keeps the chosen repos; members get "Ask an admin to reconnect
  it." It is worked out when read (`src/lib/integrations/reconnect.ts`), so older
  connections need no backfill. An uninstalled GitHub App shows in Learn from repo, not
  on this line.
- **Disconnect sticks.** Social token refresh writes are compare-and-set too
  (`swapTenantSocialToken`): a refresh that finds the connection gone stores nothing,
  and the post parks as not connected.

Switches:
- **No switch for these fixes.** AGENTS.md and CONTRIBUTING.md put switches on new
  features, and these repair existing behaviour. The precedent is a2b48e0 (28 Oct, the
  GDPR erase fix), which shipped without a switch after that rule came in on 19 Oct.
  1a8c08f (5 Jul) is history only, because it came before the rule.
- **Revoke on Disconnect is new behaviour**, so it sits behind `CONNECTOR_REVOKE_ENABLED`,
  and X also behind `CONNECTOR_REVOKE_X_ENABLED`, which acts only with the first one on.
  Both are "false" in `apphosting.yaml`, and turning one off again is a config change.
  Revoke runs after the local delete, best effort, with an 8 second timeout, so a failed
  or slow provider still disconnects.
- **Revoke policy** (`src/lib/integrations/revoke.ts`, `src/lib/social/revoke.ts`):
  - GitLab: yes, with the refresh token when there is one.
  - The single classic GitHub token: yes, through the one token endpoint, never
    `/grant`, which would end every brand's token for that GitHub user.
  - X: only after the two-brand check passes, because an X account connected to two
    brands may share one grant. That is why X has its own switch. X tokens minted by a
    refresh that finds the connection gone are revoked as well.
  - A GitHub App: never uninstalled, because other brands may use the installation.
  - LinkedIn and LinkedIn Pages: skipped.
  - A token replaced by a reconnect, or a classic GitHub token replaced by the GitHub
    App, is revoked only when it differs from the new one.
- **Classic GitHub revoke is a deliberate exception** to the rule that GitHub access
  goes through the read-only GitHub App. It is allowed because it only removes access.
  The classic OAuth path is to be retired later.

Google's pattern, followed:
- [developers.google.com/identity/protocols/oauth2/web-server](https://developers.google.com/identity/protocols/oauth2/web-server):
  bind `state` to a cookie so the response comes from the same browser. That is the
  nonce cookie.
- [developers.google.com/identity/protocols/oauth2/resources/best-practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices):
  encrypt stored tokens at rest, revoke tokens that are no longer needed, and keep client
  secrets in Secret Manager. Those are the sealed refresh token, revoke on Disconnect,
  and the existing secrets.
- [developers.google.com/google-ads/api/docs/oauth/credential-management](https://developers.google.com/google-ads/api/docs/oauth/credential-management):
  refresh tokens can be invalidated at any time, so plan for it. That is the reconnect
  line.

Consequences:
- No app path creates a member today: the only `addTenantMember` call adds an admin, and
  home brand claims are always minted as admin in `src/lib/auth/session.ts`. So nobody
  loses access now. Members invited later will ask an admin.
- ADR-0003 P2: its precondition ("before shipping admin-only surfaces") was crossed long
  ago, with dozens of role checks across routes and gates. There is no way to lower a
  role today, so nothing is exposed yet, but a session cookie keeps its role for up to
  5 days after one is lowered. Pieces A and M must revoke refresh tokens or read live
  claims before roles can be lowered.
- These secrets still lack AAD on the global tenant document (every access token, and
  the social refresh tokens), and are not kept in the brand's region. That is
  connectors piece 5.
- PR #46 (connect an already installed GitHub App, finish installs made on GitHub) is to
  be closed and redone on this gate and nonce, behind `GITHUB_APP_LINK_ENABLED` set to
  "false".

Where: `src/lib/integrations/` (`admin.ts`, `providers.ts`, `crypto.ts`,
`tokenRefresh.ts`, `reconnect.ts`, `revoke.ts`, `flags.ts`), `src/lib/social/revoke.ts`
and `tokenRefresh.ts`, the compare-and-set writes in `src/lib/tenant/control.ts`; help
`/help/connected-accounts` and `/developers/connect-your-code`.

---

## ADR-0005 · Sign-ups from a brand's own site go to a launch, with a site key (2026-10-25)

Context: a brand wanted its own "Get the weekly newsletter" box (not our embed) to feed
a newsletter in YouGrow. Three facts shaped the answer. API v2 users (connected-product
users) never get broadcasts or the weekly newsletter: those only go to a launch's
sign-ups, through Mailchimp tags (`waitlist-{id}`, `weekly-{id}`). The public waitlist
sign-up route only takes YouGrow's own form (no CORS; reCAPTCHA when it's on). And each
launch has exactly one journey on both engines (`journey_{id}`, `lcjw_{sha}`), which
takes everyone on the launch when it's turned on.

Owner decisions (2026-10-25), behind `LAUNCH_SITE_SIGNUPS_ENABLED`, off in production:
- **D1**: a newsletter is a launch of its own. Its one journey is the newsletter journey
  (a welcome, then the weekly step). No journey code changes, and the brand's waitlist
  launch is never touched. Rejected: a second journey per launch (both engines, and the
  sweeps that enrol everyone) and skipping journeys (a new "no journey" mark both engines
  must respect, and no welcome email).
- **Site keys**: one per launch, `ygl_…` / `ygls_…`, sealed under `CONNECT_SECRET_ENC_KEY`
  with their own purpose labels (no new secret for self-hosters), routed by the
  control-plane `launch_keys/{keyId}`, separate from `connection_keys` so a site key
  never works as a product key or the reverse. `POST /api/v2/signups`, server to server.
- **YouGrow always confirms**: a site sign-up is unconfirmed whatever the launch's double
  opt-in setting; at most one confirmation per address per launch a day.
- **D2**: the confirmation link opens a page with a Confirm subscription button (POST),
  so mail scanners that open links can't confirm for someone. Existing launches keep
  confirming on the click.
- **D3**: someone who unsubscribed can sign up again; confirming lifts their
  unsubscribe (brand-wide, and the page says so). Spam reports and hard bounces are never
  lifted. Mailchimp won't resubscribe a member it holds as unsubscribed, so they're set to
  pending and Mailchimp asks them once more.
- Unsubscribes stay in YouGrow; nothing is sent to the brand's server for these people.

Where: `src/lib/waitlist/siteKeys.ts`, `siteKeyAuth.ts`, `siteSignup.ts`,
`siteSignupHttp.ts`, `siteConfirmHttp.ts`; help `/help/newsletter-from-your-site`;
developer docs `/developers/site-signups`.

---

## ADR-0004 — Waitlist journeys move to the lifecycle engine (2026-09-24)

Context: a launch's welcome & nurture journey ran on the original waitlist
engine (a job per step in `email_jobs`), while connected products' journeys ran
on the lifecycle engine (versions, test/shadow/live, a lease per person). Two
engines meant two editors, and the original one stranded people when a journey
was paused. Owner decisions (2026-09-24): move fully, staged, one launch at a
time; people part-way through finish on the original engine; nobody ever gets
both engines' emails; new signups during a pause join and wait; people held
over 90 days leave; stranded people are recovered after a dry run; waitlist
sends are capped at 10,000 a day at any time of day and never dropped over a
cap; the owner's launches go first.

Decision (engine move D1–D6, one PR, every part behind a flag off in prod):
- **D1** — the original engine HOLDS a paused or archived journey's steps
  instead of ending them (`WAITLIST_JOURNEY_HOLD_ON_PAUSE`), and stamps each
  person's engine (`signup.journeyEngine`).
- **D2** — a lifecycle journey's audience can be a launch's waitlist (`lcjw_`
  per launch). Waitlist enrolments live in their own collection and due queue
  (`waitlist_enrolments`, two composite indexes) so product journeys are never
  slowed down. The lease/claim/commit/walk loop is shared (`enrolmentRun.ts`).
  Kill switch `WAITLIST_ENGINE_ENABLED` holds, never drops. `LIFECYCLE_MODE_CEILING`
  doesn't apply to waitlist journeys.
- **D3** — parity with the original engine: its renderer, sender, v1
  unsubscribe links, tracking, `signup.*` conditions (its own two-state
  evaluator) and A/B allocation; any-time sending; waits counted from the
  previous step; no hard stop. A converter keeps node, branch and variant ids,
  so each email's history continues. A golden parity suite runs both engines on
  a simulated clock.
- **D4** — the lifecycle editor's welcome-journey mode, one launch → journey
  mapping for every screen, and Vizzy's drafts saved as lifecycle drafts for
  moved launches (`NEXT_PUBLIC_WAITLIST_ENGINE_UI_ENABLED`).
- **D5** — per-launch switching (`campaign.waitlistEngine`: legacy, rehearsal,
  lifecycle) with rehearsal in shadow, a switch with no backfill, a drain that
  retires the original journey, and rollback; a pilot list
  (`WAITLIST_ENGINE_PILOT_TENANTS`, `*` = everyone); the zero-double-send check.
- **D6** — retirement as a switch, not a deletion: `WAITLIST_LEGACY_EDITOR`
  (`read_only`, then `retired`) once every launch has moved and drained and 30
  days have passed. The original engine keeps sending whatever is queued, and
  v1 unsubscribe links keep working, permanently. Deleting the dead code can
  wait for a later tidy-up.

Consequences: two enrolment collections to maintain; `journey_step` processing
stays until no jobs remain; readers must go through the launch → journey
mapping (`src/lib/journey/launchJourney.ts`) rather than `journey_{campaignId}`.

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

Update (2026-07-05, OWASP audit A07 fix): "Google-only" is now ENFORCED in server
code, not just the login UI + console. `ensureAdminAccess` (src/lib/auth/session.ts)
requires a verified Google identity (`isVerifiedGoogleIdentity`: `email_verified ===
true` AND `firebase.sign_in_provider === "google.com"`) before the allowlist/bootstrap
run — closing a bypass where, if a non-Google provider were ever enabled on the
Identity Platform project, a self-asserted `anyone@yougrow.ai` token could pass the
domain allowlist. The check is bypassed only against the local Auth emulator (the
email/password smoke test). This also separates AUTHENTICATION (verified Google —
universal) from AUTHORIZATION (which tenant/role — the `isAllowedAdmin` allowlist +
claims bootstrap), so a **future self-service model** where verified non-`@yougrow.ai`
Google users create their OWN tenants slots in at the labelled seam in
`ensureAdminAccess` without weakening the auth gate. Reminder: keep Email/Password (and
anonymous) sign-in DISABLED on the prod Identity Platform project as defense-in-depth.

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
An earlier sibling app already ran this named-database pattern in production.

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
- **Provisioning:** all three regional databases now exist in **dev** (verified): `(default)`@`nam5` (US), `signups-eu`@`eur3` (EU), `signups-asia`@`asia-southeast1` (Asia). `region.ts` has all three `provisioned: true`; `firebase.json` lists all three so `firebase deploy --only firestore` pushes the deny-all rules + composite indexes to each. (Prod: provision the EU/Asia databases there before routing an EU/Asia tenant.)

---

## ADR-0001 — MVP runtime, security posture, tenancy & scoring (2026-06-15)

Context: kickoff. The original product requirements were validated against current Google
Cloud docs (see [ARCHITECTURE-AND-DELIVERY.md](./ARCHITECTURE-AND-DELIVERY.md)).
Four decisions confirmed with the founder:

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | **Edge security at MVP** | **Firebase App Hosting + app-layer reCAPTCHA Enterprise + App Check** (no edge Cloud Armor yet) | App Hosting already runs behind a Google-managed LB/CDN you can't attach Cloud Armor to. App-layer `createAssessment` uses the *same* reCAPTCHA risk engine. Edge WAF mainly adds pre-compute volumetric absorption + SQLi/XSS rules — low value on a Firestore (no-SQL) MVP. If a public endpoint is later attacked, peel just that route onto raw Cloud Run + Cloud Armor. |
| 2 | **VPC-SC perimeter / CMEK** | **Defer** — no compliance driver yet | Data is encrypted at rest by default. Keep the design VPC-SC-*ready* (Direct VPC egress, scoped SAs) so the upgrade is non-breaking. Revisit on first enterprise/SOC2/GDPR driver. |
| 3 | **Tenant isolation enforcement** | **Application code**, via the centralized `forTenant(ctx)` repository | Firestore Security Rules do NOT protect server-side (service-account) access. Rules are kept as a deny-all backstop. `tenantId` is always derived server-side (host→tenant map or verified `tenant_id` claim), never from a request body. |
| 4 | **Leaderboard scoring** | Per-campaign **`spotsToMoveUponReferral`** (admin-editable integer); `score = amountReferred × spotsToMoveUponReferral`; ties broken by `createdAt ASC` | Honours the founder's "spots skipped per referral" model. `score` stays a small pure integer — we deliberately do NOT fold the Unix timestamp into it (avoids the seconds-vs-ms precision bug and a magic constant). Exact position/leaderboard math is finalized in Phase 2. Time is always integer Unix **seconds**. |

### Runtime / stack
- **Next.js 15 + React 18 + TypeScript 5.6**, Tailwind, Zod, Vitest.
- Deploy on **Firebase App Hosting**; two projects, one for dev and one for prod. Prod uses `minInstances: 1`.
- Firestore accessed via `firebase-admin` (Application Default Credentials; no key files). `firestore-bigquery-export` extension on a **Blaze** project for the analytics pipeline (Phase 2) — the BigQuery *sandbox* cannot stream.

### Data model (from the original data schema)
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
- **Embeddable widget — per-tenant `frame-ancestors` (deferred 2026-06-16; shipped open).** The widget (`/embed/*`, `/embed.js`) ships with `Content-Security-Policy: frame-ancestors *` and `X-Frame-Options` dropped for that route only (all other routes stay `frame-ancestors 'none'`) — so any site can embed the widget today. Acceptable for MVP: the embed exposes only what `/waitlist/<id>` already serves publicly, and the write path is guarded by reCAPTCHA + double opt-in (worst case is mild signup-form clickjacking, which double opt-in neutralizes). **To do later (gated on real third-party tenants):** restrict each tenant's widget to an approved embed allowlist. Notes for whoever picks this up: (1) this is NOT the same as `tenant.allowedOrigins` — those are the tenant's own Host-routing domains, whereas embed ancestors are the *parent sites* permitted to frame the widget; add a dedicated field (e.g. `campaign.embedAllowedAncestors` or tenant-level). (2) `next.config.ts` `headers()` is static and can't read Firestore per-request, so this needs Node-runtime middleware (firebase-admin is Node-only) or an edge-readable cache of each tenant's allowed ancestors. See `next.config.ts` (`/embed/:path*` header block) and docs/self-host.md ("Embed the waitlist on another site").
