# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0007 · Open core: the Enterprise boundary, licence keys, licences and the CLA (2026-11-19)

Context: on 2026-11-19 the owner chose open core. The app stays AGPL-3.0, Enterprise
features live in `src/ee` under a commercial licence, and the Node SDK stays MIT. Some
features (single sign-on, user provisioning, field and record level access, audit log
export and retention, retention rules, legal hold) will need a licence key on a
self-hosted copy. This record lays the code boundary and the draft licences before any
Enterprise feature exists, so the lawyer review never holds up the code. Nothing changes
for users: no switch, no Firestore data or index, no new dependency and no Vizzy change.
No Enterprise feature is built yet, so every one of them answers "off".

Owner decisions (2026-11-19):

- **The boundary.** Only `src/lib/enterprise/registry.ts` imports from `src/ee`. Everything
  else asks the registry whether a feature is licensed, so the app builds and runs without
  the folder. Three guards hold it:
  - ESLint: an `import/no-restricted-paths` block over every code file in the repo
    (`ENTERPRISE_MESSAGE` in `eslint.config.mjs`), off only in `src/ee` and the registry.
    It sees import, export from, `import()` and `require()`. It is not part of
    `no-restricted-imports`, which the tenant layer turns off and which misses `import()`
    and `require()`. eslint-config-next already registers the import plugin and its
    resolvers, so there is no new dependency.
  - The source scan, `src/lib/enterprise/boundary.test.ts`. The rule skips a specifier it
    can't resolve, and ESLint ignores `infra`, `agents` and `workers`. So the scan reads
    every code file in the repo with the TypeScript parser (comments never count) and fails
    on any import, require, re-export, import type or `vi.mock` that reaches `src/ee`.
    `eslintBoundary.test.ts` shows the rule at error for files in `src`, `scripts`, `sdk`
    and the root, and absent for the registry and `src/ee` itself.
  - The CI job "Builds without Enterprise code" in `.github/workflows/ci.yml`. It deletes
    `src/ee`, then runs typecheck, lint, the unit tests and the build, beside the verify
    job so a result takes no longer. `agents:check` and the `check:*` steps stay in verify,
    since the guides name files in `src/ee` on purpose. Until Enterprise code lands it
    proves the steps; from then on it is the guard. No test outside `src/ee` reads or
    imports anything in it.
- **The licence key format.** `ygel_<header>.<claims>.<signature>`, each part base64url
  without padding (`src/lib/enterprise/licence.ts`).
  - The header is `{ alg: "EdDSA", typ: "ygel1", kid }`. The kid is the RFC 7638
    thumbprint of the Ed25519 public key, so a key's id comes from the key itself.
  - The claims are `{ v: 1, lid, licensee, seats, features, iat, nbf?, exp }`, times in
    seconds. The signature covers the ASCII text `ygel_<header>.<claims>`.
  - Parsing is strict: 4096 characters at most, the base64url alphabet only, and every part
    must encode back to exactly itself, because Buffer's decoder skips characters it doesn't
    know (the parser in `src/lib/connect/outboundToken.ts` allows that). The signature is
    checked before any claim is read, then the version, the claims' shape, the start time
    (300 seconds of leeway) and the end.
  - Every failure has a reason: `no_key`, `malformed`, `unsupported_alg`, `unknown_key`,
    `bad_signature`, `wrong_version`, `bad_claims`, `not_yet_valid` or `expired`. An expired
    key keeps its claims, so a later screen can say when it ended. Unknown feature ids are
    kept but never match, so a newer key still works on an older copy. The key is never
    logged.
  - The eight feature ids are `sso`, `scim`, `field_access`, `record_access`,
    `audit_export`, `audit_retention`, `retention_rules` and `legal_hold`
    (`src/lib/enterprise/features.ts`). They are written into keys, so renaming one means
    reissuing every key that lists it.
- **The verifier sits in core, not in `src/ee`.** Core must be able to answer "off" with no
  `src/ee`, and the verifier is pure, offline and tested with a fresh key pair on every run,
  so no private key is ever committed. Being AGPL code doesn't change the Enterprise
  Licence: production use of `src/ee` needs a subscription and a key, whatever the verifier
  says. Whether the licence's clause against working around the key check adds anything when
  the verifier itself is AGPL is a question for the lawyer, not a settled fact.
- **Signing keys follow Google's pattern** for asymmetric signing keys
  (https://docs.cloud.google.com/kms/docs/key-rotation): they rotate by hand. Publish the
  new public key first, then sign with the new version, and keep old versions until nothing
  uses them. So `LICENCE_PUBLIC_KEYS` (`src/lib/enterprise/publicKeys.ts`) takes a new key
  beside the old one, and the old one stays until every licence key signed with it has
  expired. The private key lives offline, or in Cloud KMS as an Ed25519 key, and never in a
  repository. The list ships empty, so no key verifies yet; the owner adds the production
  public key in a later commit.
- **`ENTERPRISE_LICENCE_KEY` is a setting, not a switch.** It is never compared with
  `"true"`. It is listed in `.env.example` only, never in `apphosting.yaml`, which holds
  switches. A self-hosted copy keeps it in Secret Manager and names it in its own settings
  file (`docs/self-host.md`, "Enterprise features": create the secret, give the backend
  access, and only then add the line). Empty: every Enterprise feature stays off and
  everything else works. `currentLicence` keeps the signature result for one key string and
  checks the times on every call.
- **Composition.** The registry answers one question: may this deployment run feature X?
  Yes when this build has the code for X and the deployment's key is valid and lists X.
  - It is deployment level and takes no brand or organisation, and its signature will not
    change. It answers in the order `code_absent`, the key's failure, `not_in_licence`,
    `licensed`, and never throws on a bad setting. `EE_CODE` is empty, so today every
    feature answers `code_absent`.
  - Hosted copies carry their own key: hosted dev and prod each get an owner-issued key,
    kept with that deployment's private settings, from piece M (the first Enterprise code)
    on. One code path runs everywhere, with no hosted bypass.
  - Piece A adds the organisation plan check ("may this organisation use X") as a separate
    function in `src/lib/plans`. Callers ask both.
  - `src/lib/plans/brandAccess.ts` stays the per-brand gate for metered features. Piece A
    updates its "the one place a plan or tier check belongs" comment.
  - `registry.ts` and `licence.ts` use `node:crypto`, so they run on the Node runtime only,
    never from middleware or a client component. `features.ts` has no imports, so pages can
    use it. Import the registry as `@/lib/enterprise/registry`; other folders have their
    own `registry.ts`.
- **Seats.** Piece A counts an organisation's users. Piece M enforces a key's seats, and
  adds the grace period after a key expires and the licence status screen.
- **Licences.** `LICENSE` is untouched, so GitHub still detects AGPL-3.0. `LICENSING.md` at
  the root is the map:
  - a copyright and licensor line, YouGrow.AI Limited, as in `sdk/node/LICENSE`;
  - AGPL-3.0-only for everything not listed, the YouGrow Enterprise Licence for
    `src/ee/**`, MIT for `sdk/node/**`, the SIL Open Font Licence 1.1 for each font file
    (with its notice beside it), and ISC for `src/lib/brandMap/packSiblings.ts`;
  - `package.json`'s `license` field is `SEE LICENSE IN LICENSING.md`. The lockfile's root
    entry was edited by hand to match, with no dependency change. If GitHub ever shows
    something other than AGPL-3.0 because of the root file, the map moves to
    `docs/licences.md`.
- **The section 7 permission**, in `LICENSING.md`, is a draft for the lawyer. Anyone who
  combines the app with the code in `src/ee` may convey the result, and make it available
  to users over a network. `src/ee` keeps its own licence, and the Corresponding Source of
  the AGPL parts must still be provided.
- **The YouGrow Enterprise Licence**, version 1 (`src/ee/LICENSE`), is a draft written
  fresh. Read, copy, change, share and test the code freely. Production use needs an active
  subscription and a key that covers at least the number of users. Nobody may remove,
  disable or work around the key check or its limits. Changes stay under it, and code
  outside `src/ee` is not covered. No warranty, and it ends on breach. The governing law and
  the contact are placeholders. New files in `src/ee` start with
  `SPDX-License-Identifier: LicenseRef-YouGrow-Enterprise`.
- **The CLAs.** `docs/cla/individual.md` follows the shape of the Apache ICLA, plus an
  outbound clause: you keep your copyright and grant YouGrow.AI Limited a perpetual,
  worldwide, royalty-free, irrevocable licence to use and sublicense your contributions
  under any licence terms, open source or proprietary. It adds a patent licence that ends
  for anyone who sues over the contribution; you confirm the work is yours to give, you
  answer for work made with AI tools, and it comes as is. `docs/cla/entity.md` has the same
  terms for an organisation and its named GitHub logins, signed by email. A maintainer
  records only an id, the date and the logins in `docs/cla/policy.json`; the signed copy
  stays outside the repository. Every legal text here says "Draft under legal review, not
  yet in force". The AGPL, MIT, OFL and ISC licences already apply.
  - An employer with rights in a person's work signs the entity agreement; the individual
    agreement says so in its opening and in section 5.
  - If a draft's text changes before it is final, it gets a new id (such as
    `individual-v2`) and the policy accepts only that one, so anyone who signed the draft
    signs again. A signature never stands for terms the signer didn't see.
- **The legal chain.** All of today's code was written from the maintainer's own accounts.
  The licensor line, the Enterprise Licence on `src/ee`, the section 7 permission and the
  CLAs' outbound grant all rest on a founder IP assignment of that work to the legal
  entity, YouGrow.AI Limited. It must be signed and confirmed before the first Enterprise
  sale, before any outside contribution is merged, and before the CLA check is made
  required. That is why the maintainer's account is exempt from the CLA, and why
  `CONTRIBUTING.md` says outside pull requests can't be merged until the agreements are
  final and the assignment is signed.
- **The CLA check** (`.github/workflows/cla.yml`, `scripts/check-cla.mjs`,
  `scripts/lib/cla.mjs`):
  - It runs on `pull_request_target` for pull requests to dev and main, and by hand with a
    pull request number. Only the base repository's code runs: the workflow never checks
    out the pull request, so a pull request can't change the checker that judges it. Plain
    `pull_request` was turned down for that reason. The pull request's commits and files
    are read as data through the API, with GET calls only.
  - The token can read contents and pull requests, nothing else. Checkout takes no ref and
    keeps no credentials. There is no `npm ci`, since the checker uses Node built-ins only,
    and no GitHub expression in a run line. It runs on our public repository only.
    `scripts/lib/claWorkflow.test.ts` fails if any of that changes. If code scanning flags
    the trigger, this record is why it is expected.
  - One file per signer, `docs/cla/signatures/<login>.json`, added in the signer's own pull
    request. It holds only the GitHub login, the agreement and the date, and the check
    refuses any other key, so no names or emails creep in. Two people signing at once never
    conflict, and a branch cut before someone else signed never looks like a removal.
  - `docs/cla/policy.json` is maintainer only: the accepted agreements, the exempt logins
    with why (`ygai-jezl`, `dependabot[bot]`, `github-actions[bot]`), the AI coding tools,
    and the organisations. An outside pull request may change nothing in `docs/cla` except
    adding its author's own signature.
  - Trusted reads: the policy and the signatures come from the tip of the base branch (dev
    or main), never from the pull request, so a re-run sees signatures merged since (the
    base commit GitHub records can lag). A dev to main promotion within the repository reads
    at dev's head commit, since everything on dev came through a checked pull request or the
    maintainer. A fork's branch named dev is not a promotion. The only file read from the
    pull request is its author's own new signature.
  - Who is checked: the author, each commit's author and each human co-author. The AI
    addresses and logins come from the policy (`noreply@anthropic.com` and `claude` to
    start; another tool's address is added once a real commit shows it). A commit by one of
    them counts as the pull request author's, and an AI Co-authored-by line is ignored. A
    human co-author is covered through their GitHub noreply address, or through an address
    a covered commit author in the same pull request uses. Otherwise the check fails,
    naming only the short sha, never a name or email. A commit with no linked GitHub
    account fails the same way.
  - It fails closed: a base other than dev or main, a missing or invalid policy, a file it
    can't read, or fewer commits or files than the pull request has (GitHub lists 250
    commits and 3000 files at most). The job summary says in plain words who is missing and
    how to sign.
  - The maintainer override is the ruleset bypass, not code. The check runs once the
    workflow is on main, and stays advisory until a ruleset makes it required.
- **The public list.** `/developers/open-source` gains "What is open and what is
  Enterprise": each part and its licence, the Enterprise features from
  `ENTERPRISE_FEATURES` ("None is released yet"), what only the hosted service offers
  (`HOSTED_ONLY`), and that the app builds without `src/ee`. It sits behind
  `DEVELOPERS_DOCS_ENABLED` like the rest of the page.

Open questions for the lawyer:
- Section 13: is the network wording in the section 7 permission needed, and is it enough?
- Does the Enterprise Licence's clause against working around the key check add anything
  when the verifier itself is AGPL?
- Does Enterprise code that sits unused in a self-hoster's production build count as
  production use?
- Work made with AI tools: is the CLA's clause on it enough, and what does the outbound
  grant cover there?
- Is adding a signature file in one's own pull request a valid way to sign?
- Is a signature made against the draft valid once the text is final, if the text didn't
  change, or should everyone sign again?
- Should an employer's written permission be enough, as in the Apache ICLA, or must an
  employer with rights always sign the entity agreement, as the draft says today?
- The entity agreement's Schedule A and signing block: are they enough, or does it need
  its own execution page?
- How long should signed entity CLAs be kept?
- The governing law and the contact, both placeholders today.

Deferred:
- The fallback alias, with the first Enterprise code (piece M). Once the registry imports
  from `src/ee`, a build without the folder needs an alias for those imports: tsconfig
  `paths`, a vitest alias chosen with `existsSync`, and Turbopack's `resolveAlias` if it is
  adopted.
- Hosted keys, the seat count, the grace period and the status screen (piece M).
- The production public key (the owner), and the tool that issues keys, which lives in the
  private operations repository.
- Making the CLA check required, after the lawyer and the founder IP assignment. At the
  same time, set fork pull request workflows to need approval for all outside
  contributors. A required check matches on its name and on the GitHub Actions app, which
  every workflow shares, so a pull request that adds its own job named CLA could otherwise
  stand in for the real one. The `cla.yml` header says the same.
- Trademark.

Consequences: the CI job without `src/ee` uses runner minutes on every pull request.
Signature files are keyed by lowercase login, so someone who renames their GitHub account
signs again. A pull request over GitHub's listing limits fails the CLA check, so it is split
or merged with the bypass.

Where: `src/lib/enterprise/` (`features.ts`, `publicKeys.ts`, `licence.ts`, `registry.ts`,
`boundary.test.ts`, `eslintBoundary.test.ts`), `eslint.config.mjs`,
`.github/workflows/ci.yml`, `.env.example`; `src/ee/` (`LICENSE`, `README.md`,
`AGENTS.md`), `LICENSING.md`, `package.json`; `docs/cla/` (`individual.md`, `entity.md`,
`policy.json`, `signatures/README.md`), `scripts/lib/cla.mjs`, `scripts/check-cla.mjs`,
`.github/workflows/cla.yml`, `scripts/lib/claWorkflow.test.ts`;
`src/app/developers/open-source/page.tsx`, `CONTRIBUTING.md`, `docs/self-host.md`.

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
