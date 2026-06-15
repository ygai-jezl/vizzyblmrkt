# vizzybl-marketing — Delivery & Architecture Assessment

**Prepared by:** Senior Cloud Architect • **Date:** 2026-06-15
**Scope:** Validation of the vizzybl-marketing PRD (multi-tenant SaaS waitlist MVP) against current (mid-2026) Google Cloud documentation, synthesized from 7 specialist reviews.
**Bottom line:** The PRD's *instincts* are good and most named GCP controls are real — but several headline claims are factually wrong (free-tier streaming, security-rules-based tenant isolation, "Gemini 1.5 Pro"), and the proposed architecture is **over-built for an MVP** in exactly the way that creates the "tech debt adds up quickly" problem you're worried about. The right move is a lean App Hosting + Firestore + scoped-service-account footprint with isolation enforced *in application code*, deferring the VPC-SC perimeter, internal-only services, and the multi-agent platform.

---

## 1. Executive Summary

- **The topology shape is sound; the specific building blocks are dated or over-scoped.** Public edge → internal processors → Firestore is a valid pattern, but it should not be the *MVP* footprint, and it uses a deprecated egress mechanism (Serverless VPC Access connector).
- **Three claims are flat-out wrong and will cause go-live surprises if not fixed now:** (1) the analytics pipeline **cannot run on the BigQuery sandbox/free tier** — the sandbox blocks streaming, DML, and DTS and expires all tables after 60 days ([sandbox docs](https://docs.cloud.google.com/bigquery/docs/sandbox)); a Blaze billing account is mandatory. (2) **Firestore Security Rules do nothing for your server paths** — server client libraries "bypass all Firestore Security Rules and instead authenticate through Application Default Credentials" ([docs](https://docs.cloud.google.com/firestore/native/docs/security/get-started)), so tenant isolation **must** live in app code. (3) **"Gemini 1.5 Pro" is end-of-life** for 2026; use `gemini-2.5-flash`/`gemini-3.5-flash`.
- **DO THIS NOW to avoid expensive remediation:** build a **single, centralized tenant-aware data-access layer** that injects `where('tenantId','==', ctx.tenantId)` on every read and stamps it on every write, with `tenantId` derived **server-side** (never from the request body). Retrofitting this after launch is a cross-tenant-leak-class rewrite.
- **DO THIS NOW (#2):** pin the leaderboard score to **integer Unix seconds**, and re-weight the formula. The PRD's `Referrals*500 - signupSeconds` makes one referral worth only **8.3 minutes** of signup priority; and if milliseconds ever leak in, the timestamp term silently swamps referrals (JS doubles are safe only to 2^53).
- **DO THIS NOW (#3):** decide the **App Hosting vs raw-Cloud-Run** question explicitly. App Hosting (the sibling-app convention) is the correct lean MVP runtime, but its managed load balancer **cannot** attach Cloud Armor / reCAPTCHA-WAF or join a VPC-SC perimeter. If edge WAF/VPC-SC is a hard requirement you must run raw Cloud Run behind your own external ALB — a materially heavier build. For the MVP, do reCAPTCHA Enterprise at the **application layer** instead.
- **Replace "Serverless VPC Access connector" with Direct VPC egress** everywhere — it is the documented 2026 recommendation, scales to zero, and has **no always-on VM charge** ([docs](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc)).
- **Defer the heavy machinery.** The full VPC-SC perimeter, internal-only Cloud Run, Agent Engine/Runtime, Agent Identity, A2A, and the 6-agent system are **post-MVP**. For a waitlist MVP they are premature complexity (the inverse of the tech-debt you want to avoid). Keep the design *VPC-SC-ready* (Direct VPC egress, ingress settings) so the upgrade is non-breaking when compliance justifies it.
- **The good news:** reCAPTCHA Enterprise + Cloud Armor (CRS 4.22), Model Armor, Sensitive Data Protection, Firestore aggregation pricing, Cloud CDN counter caching, Identity Platform multi-tenancy, and the firestore-bigquery-export extension are all **real and current** — the PRD just needs corrected versions, the right cost model, and isolation in the right layer.

---

## 2. PRD Reality Check

Verdicts: **Confirmed** / **Outdated** / **Incorrect** / **Needs-change**. Ordered by impact.

| # | PRD Claim | Verdict | Corrected Current Reality (2026) | Citation |
|---|-----------|---------|----------------------------------|----------|
| 1 | "Firestore Security Rules enforce matching tenantId" for the platform | **Incorrect** | Rules apply **only to client/mobile SDK** access. Server client libraries (`firebase-admin` **and** `@google-cloud/firestore`) **bypass all rules** and authorize via IAM/ADC. Since all writes flow through Cloud Run service accounts, rules contribute **zero** isolation. Enforce `tenantId` in app code; keep rules at `if false` as a backstop. | [firestore security get-started](https://docs.cloud.google.com/firestore/native/docs/security/get-started), [insecure-rules](https://firebase.google.com/docs/firestore/security/insecure-rules) |
| 2 | "BigQuery 1TB free query/mo, sandbox/free tier" for the streaming pipeline | **Incorrect** | The **sandbox does NOT support streaming, DML, or DTS, and auto-expires all tables after 60 days.** The extension streams via Cloud Functions and requires **Blaze**. You need a **billing-enabled** project; free *allowances* (1 TiB query, 10 GiB storage) still apply but the zero-dollar/sandbox path is not real. | [sandbox limitations](https://docs.cloud.google.com/bigquery/docs/sandbox), [firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) |
| 3 | "<5s near-real-time streaming SLA" | **Incorrect** | **No Google SLA exists.** The path is Firestore → Eventarc → Cloud Function → BigQuery; Eventarc delivers **at-least-once, unordered**, with cold starts and partition-placement lag (minutes, rarely up to 90). Restate as a **best-effort target (~seconds)**; de-dupe downstream. | [eventarc](https://docs.cloud.google.com/firestore/native/docs/eventarc), [write-api](https://docs.cloud.google.com/bigquery/docs/write-api) |
| 4 | "Gemini 1.5 Pro via BigQuery AI functions"; Vertex AI Image Generation | **Outdated** | 1.5 Pro is effectively EOL. Use `gemini-2.5-flash`/`gemini-3.5-flash` (copy), `gemini-2.5-pro`/preview `gemini-3.1-pro` (reasoning), `gemini-2.5-flash-image` (images; Imagen 3.x/4.x GA endpoints deprecate by **2026-06-30**). The BigQuery mechanism (`AI.GENERATE_TEXT`) is current — just bind the remote model to a current id. | [model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), [AI.GENERATE_TEXT](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-generate-text) |
| 5 | "Serverless VPC Access connector" for Cloud Run → VPC | **Needs-change** | **Direct VPC egress** is the documented 2026 recommendation: no connector VM, **scales to zero, no VM charge**, lower latency. Keep a connector only if you hit Cloud NAT cold-start (30s+) issues; mitigate startup delay with an HTTP startup probe. | [connecting-vpc](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc), [vpc-direct-vpc](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc) |
| 6 | "ADK 2.0" for the agents (TS codebase) | **Needs-change** | ADK 2.0 (graph Workflow Runtime) is **Python-only at GA (2026-05-19)**. The sibling app pins `@google/adk ^0.3.0` (TypeScript), far behind. A single TS `LlmAgent` is fine for the MVP; do **not** assume cross-language 2.0 parity. | [adk.dev/2.0](https://adk.dev/2.0/), [adk typescript](https://adk.dev/get-started/typescript/) |
| 7 | `Score = Referrals*500 - signupUnixTimestamp`, sorted natively | **Needs-change** | Tie-break **direction is correct**, but: (a) one referral = only **500s ≈ 8.3 min** of priority — under-weighted; (b) **seconds-vs-ms trap** — never use `Date.now()`; pin to integer seconds. Prefer two-field ordering (`referrals DESC, signupSeconds ASC`) to kill the magic number. | [data-types](https://firebase.google.com/docs/firestore/manage-data/data-types) |
| 8 | "Gemini Enterprise Agent Platform Agent Identity" instead of a master key | **Confirmed** (but heavyweight) | Real and **GA**: each agent gets a SPIFFE principal + 24h X.509 cert, mTLS-bound un-replayable tokens, per-agent IAM. **Stronger** than service accounts. But it requires deploying to **Agent Runtime** (reasoningEngines) — **defer to the multi-agent phase**. | [agent-identity](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/runtime/agent-identity) |
| 9 | Public-ingress Cloud Run lives fully inside the VPC-SC perimeter | **Incorrect** | Setting Cloud Run `ingress=all` **disables VPC-SC enforcement** for that service. The perimeter protects the **data tier** (Firestore + internal services); the public router is protected by the **LB/Cloud Armor edge**, not VPC-SC. | [run vpc-sc](https://docs.cloud.google.com/run/docs/securing/using-vpc-service-controls) |
| 10 | App Hosting can sit behind Cloud Armor/VPC-SC (reuse sibling stack at edge) | **Incorrect** | App Hosting's managed LB exposes **no** Cloud Armor / WAF / `ingress=internal` / VPC-SC knobs. Edge WAF requires **raw Cloud Run + your own external ALB**. App Hosting is fine for an MVP that doesn't yet need edge WAF. | [app-hosting](https://firebase.google.com/docs/app-hosting/about-app-hosting), [optimize-cache](https://firebase.google.com/docs/app-hosting/optimize-cache) |
| 11 | "Datastream for Firestore → BigQuery" as an alternative | **Incorrect** | **Datastream does not support Firestore.** Sources are MySQL, PostgreSQL, AlloyDB, SQL Server, Oracle only. Real alternatives: the extension (default), Pub/Sub BigQuery subscription + CDC, or app-level Storage Write API dual-writes. | [datastream-for-bigquery](https://cloud.google.com/datastream-for-bigquery) |
| 12 | BigQuery RLS via "`@run_time_tenant_context WHERE`" param | **Incorrect** | BigQuery RLS binds a **fixed filter to IAM grantees** (or `SESSION_USER()`), **not** a runtime query parameter. A shared analytics SA = all tenants resolve to one principal → no isolation. Use authorized views per tenant or dataset-per-tenant with scoped SAs. | [row-level-security-intro](https://docs.cloud.google.com/bigquery/docs/row-level-security-intro), [multi-tenant best practices](https://docs.cloud.google.com/bigquery/docs/best-practices-for-multi-tenant-workloads-on-bigquery) |
| 13 | Leaderboard rank via live `count(score > userScore)`; "1 read per 1000 docs" | **Confirmed pricing, risky perf** | Pricing is correct (1 read / 1000 index entries, min 1). **Nuance the PRD misses:** a query with ≤1 range field is **exempt from index-entry charges** → the rank `count()` bills as **1 read** regardless of size. BUT `count()` scales with **dataset size**, has a **60s `DEADLINE_EXCEEDED`** ceiling, and **can't use realtime listeners** — too slow for `<150ms` live. Precompute/cache it. | [firestore pricing](https://firebase.google.com/docs/firestore/pricing), [aggregation-queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries) |
| 14 | Host-header → tenantId resolved at the edge | **Confirmed (routing only)** | URL-map `hostRules` fan domains to the router. But Google: the LB **does not validate the Host header** and clients can spoof it — "don't use the hostname field to implement access control." Use for routing; enforce tenant authz **server-side**. | [url-map-concepts](https://docs.cloud.google.com/load-balancing/docs/url-map-concepts) |
| 15 | Model Armor scans agent output (with LLM-as-a-Judge) | **Confirmed, with gaps** | Model Armor is real/current (prompt-injection, jailbreak, PII, malicious URLs). **Two gaps:** it scans only the **initial prompt + final response** (not intermediate tool steps), and it **fails open** on error/region-unavailability. It is **not** an LLM-as-a-Judge — build that separately if needed. | [model-armor overview](https://docs.cloud.google.com/model-armor/overview), [vertex integration](https://docs.cloud.google.com/model-armor/model-armor-vertex-integration) |
| 16 | reCAPTCHA Enterprise + Cloud Armor (OWASP preconfigured rules) at edge | **Confirmed, pin versions** | All real. Pin **OWASP CRS 4.22** (PRD's CRS 3.x is outdated), start at sensitivity 1 in preview, note the **64 kB body-inspection limit**, validate reCAPTCHA assessments **server-side** (verify `valid` + `action` match). | [waf-rules](https://docs.cloud.google.com/armor/docs/waf-rules), [implement-waf-ca](https://docs.cloud.google.com/recaptcha/docs/implement-waf-ca) |
| 17 | Cloud CDN 1–5 min cache for public counters/leaderboard | **Confirmed** | Valid. Use `Cache-Control: public, s-maxage=60..300`. **Caveats:** responses with `Set-Cookie`/`private` are **not** cached; cache key must include tenant host; cached payload must be **fully PII-masked** (shared across all anonymous viewers). | [cdn caching](https://docs.cloud.google.com/cdn/docs/caching), [optimize-cache](https://firebase.google.com/docs/app-hosting/optimize-cache) |
| 18 | "Avoid firebase-admin" as a security requirement | **Needs-change** | Avoiding `firebase-admin` is a **design preference, not a security control** — it authenticates via a scoped SA exactly like `@google-cloud/firestore`. The real control is **per-service least-privilege SAs**. The sibling app already uses `firebase-admin`; aligning with it is acceptable. | [firestore libraries](https://docs.cloud.google.com/firestore/native/docs/reference/libraries) |

---

## 3. Recommended MVP Reference Architecture

**Principle:** ship the **leanest secure footprint** that delivers the waitlist MVP, and keep it *upgrade-ready* for the perimeter without re-platforming.

**Runtime recommendation: Firebase App Hosting** (Next.js 15, zero-config) for the public landing page, signup/processor API, and admin portal — this *is* managed Cloud Run + Cloud CDN + Cloud Build + Secret Manager + a Google-managed LB, matches the sibling `vizzybl-portal` convention, and scales to zero (≈$0.01 at 10k visits/mo). **Do reCAPTCHA Enterprise at the application layer** (App Hosting's LB can't host Cloud Armor). Reserve raw Cloud Run + self-managed ALB only if/when edge WAF or a VPC-SC perimeter becomes a hard requirement.

```
                          Internet (anonymous + tenant custom domains)
                                          │
                                          ▼
                ┌─────────────────────────────────────────────────────┐
                │   Firebase App Hosting (managed LB + Cloud CDN)      │
                │   Next.js 15 SSR on Cloud Run (min-instances=1 prod) │
                │   • Public hosted landing page (per-tenant)          │
                │   • /api/signup  (reCAPTCHA Enterprise createAssessment server-side)
                │   • /api/leaderboard (GET, anonymous, PII-masked, CDN s-maxage=60-300)
                │   • Admin portal (Identity Platform tenants, RBAC)   │
                └───────────────┬─────────────────────┬───────────────┘
                                │ (Cloud CDN serves    │ scoped per-service SA
                                │  cached counters,     │ (ADC, no keys)
                                │  skips origin)        ▼
                                │            ┌──────────────────────────┐
                                │            │ Firestore (default DB)   │
                                │            │ single DB + tenantId field│
                                │            │ Rules = `if false` backstop│
                                │            │ Isolation enforced IN CODE │
                                │            └──────────┬───────────────┘
                                │                       │ firestore-bigquery-export
                                │                       │ (Cloud Function trigger, Blaze)
                                │                       ▼
                                │            ┌──────────────────────────┐
        ┌───────────────────────┴──────┐    │ BigQuery (BILLING ENABLED)│
        │ Cloud Tasks (async)          │    │ changelog table:          │
        │ • offboarding email          │    │  PARTITION BY date        │
        │ • blast queue (idempotent)   │    │  CLUSTER BY tenantId      │
        │ Cloud Scheduler → kicks blasts│   │ Authorized views / RLS    │
        └───────────────────────────────┘   │  per tenant (scoped SAs)  │
                                             └──────────────────────────┘
   ── DEFERRED (post-MVP, behind explicit compliance/scale trigger) ──
   ✗ Full VPC-SC perimeter   ✗ internal-only Cloud Run   ✗ self-managed ALB + Cloud Armor
   ✗ Agent Engine/Runtime    ✗ Agent Identity / A2A      ✗ 6-agent system / Memory Bank
```

### Component decisions

- **Hosting:** App Hosting backends, **one per environment** in **separate GCP projects** (`vizzybl-marketing-dev`, `vizzybl-marketing-prod`) per Firebase guidance, config via `apphosting.yaml` + `apphosting.prod.yaml` overrides, secrets in Secret Manager (pinned versions in prod). Set **`minInstances: 1`** on the prod public backend to kill cold starts (the pending queue can be up to **10s or 3.5× startup time**); `minInstances: 0` in dev for zero idle cost.
- **Data model & tenantId enforcement:** **single (default) Firestore database** + `tenantId` field. **Not** database-per-tenant (capped at 100/project — wrong for a viral many-tenant waitlist). Isolation enforced in a **single centralized repository layer** (see §4). `tenantId` derived from the **verified host→tenant mapping**, never from request body.
- **Firestore → BigQuery pipeline:** the `firestore-bigquery-export` extension is the default (fastest, aligns with the sibling stack), on a **Blaze, billing-enabled** project. Partition the changelog **by date**, **cluster by tenantId**, promote `tenantId` to a **top-level typed STRING column** (RLS can't apply to the JSON `data` column). De-dupe in the latest view (window by `document_id` on Firestore update timestamp) because delivery is at-least-once/unordered. Keep survey answers/UTM in the JSON `data` column, project reported fields via `fs-bq-schema-views`. **Plan an initial backfill.** *(If you later enforce VPC-SC, either add the extension's Cloud Function + BigQuery to perimeter ingress/egress rules, or move ingestion in-perimeter via the Storage Write API.)*
- **reCAPTCHA / Cloud Armor:** **MVP = application-layer reCAPTCHA Enterprise** (`createAssessment` server-side: verify `tokenProperties.valid`, `action == expected`, score; tokens single-use, expire 2 min; first 10k/mo free) + Firebase App Check + per-IP app-level rate limiting. **Add Cloud Armor (CRS 4.22) only post-MVP** with a self-managed ALB if abuse warrants it.
- **Public leaderboard caching:** serve from an anonymous, **cookie-free** endpoint that masks PII **before serialization**, with `Cache-Control: public, s-maxage=60..300`. Keep this route free of Next.js middleware/cookies (they force `Vary` and disable CDN caching). Serve **precomputed rank** (rollup counters), not a live `count()` per request.
- **Async work:** Cloud Tasks (at-least-once → **idempotent handlers**, up to 30-min timeout) for offboarding emails + blast queue; Cloud Scheduler triggers blasts; signup writes use a **deterministic doc ID** (normalized email / idempotency key) so retries never duplicate.

### Why deferring is the *right* call (not laziness)

The full VPC-SC perimeter blocks **Cloud Build continuous deployment inside the perimeter**, forces restricted-VIP DNS + deny-all firewall plumbing, supports only `ANY_IDENTITY` ingress for Cloud Run, and is **incompatible with App Hosting** (public by design) — that is real, ongoing operational toil for a waitlist with no enterprise-PII compliance driver yet. The 6-agent system, Agent Runtime, Agent Identity, A2A, and Memory Bank are similarly heavy: the **only MVP agent is the Email Hub**, which is a single in-process `LlmAgent`. Building the full machinery now **is** the tech debt you're trying to avoid. Keep the architecture VPC-SC-*ready* (Direct VPC egress, correct ingress settings, scoped SAs) so the upgrade is non-breaking later.

---

## 4. Multi-Tenant Isolation Model

**The single most load-bearing control in the whole platform.** Because every read/write flows through a Cloud Run **service account** (server SDK), **Firestore Security Rules enforce nothing** on that path. Isolation is an **application-code** responsibility.

### Data model

- **Firestore:** single default database; every tenant-scoped document carries a top-level `tenantId` (and `campaignId` where relevant). Composite indexes pre-created in `firestore.indexes.json`:
  - Leaderboard: `(tenantId ASC, campaignId ASC, isVerified ASC, score DESC)`
  - Recent signups: `(tenantId ASC, createdAt DESC)`
  - Keep queries to **≤1 range field** to retain the index-entry-read cost exemption.
- **BigQuery:** changelog table partitioned by date, **clustered by `tenantId`**, with `tenantId` promoted to a **typed top-level STRING column** (RLS/clustering cannot operate on the JSON `data` blob).

### Enforcement by layer

| Layer | Control | Notes |
|-------|---------|-------|
| **Browser / client SDK** | Firestore Rules = `allow read, write: if false` | Pure **backstop** against accidental direct client access. Not the real control. Rules are *not filters* — a client query without an explicit `tenantId` filter is **rejected**, not auto-scoped. |
| **Server / app code** | **Centralized tenant-aware repository** that injects `where('tenantId','==', ctx.tenantId)` on every read and stamps `tenantId` on every write | **The actual control plane.** `ctx.tenantId` derived server-side from the verified host→tenant mapping or verified ID-token claim — **never** from the request body. Forbid raw `db.collection()` calls via lint rule; add Vitest tests asserting every query path carries a tenant filter; CI red-team test that a wrong-tenant identity returns nothing. |
| **IAM** | Per-service least-privilege service accounts (router, processor, worker) | No shared "master" SA. Roles scoped to `roles/datastore.user`, `roles/cloudtasks.enqueuer`, `roles/secretmanager.secretAccessor`, `roles/recaptchaenterprise.agent` as needed. Enable org policies `iam.disableServiceAccountKeyCreation`. |
| **BigQuery (analytics)** | **Per-tenant authorized views** in a separate dataset (MVP) → **dataset-per-tenant + scoped SAs** (scale) | RLS is **not** parameter-driven; bind to IAM principals or `SESSION_USER()`. Authorized-view ACL cap = **2,500 resources/dataset** → group into authorized datasets, or move to dataset-per-tenant before the cap bites. Watch the **100 SA/project** soft quota for per-tenant SAs (raise early). |

### Auth / custom claims / RBAC

- **MVP:** Identity Platform (GCIP) multi-tenancy for the **admin portal** — `tenant_id` claim in ID tokens; tenant-scoped tokens are invalid across tenants (prevents cross-tenant replay). Custom claims (`<1000 bytes`, access-control only) carry **Normal vs Admin** role.
- Backend must **`verifyIdToken`** and read claims from the **verified** token — never trust a client-supplied claim. Claims propagate only on **token refresh**, so force refresh on role change.
- **Public signup/leaderboard sit outside auth** → tenant resolution there is **host-header → server-side lookup**, validated before any write.

---

## 5. Security & OWASP Baseline (bake in now)

OWASP Top 10 2021 + API Security Top 10 2023 + LLM Top 10, mapped to specific GCP controls.

| Pri | OWASP | Risk | GCP Control (specific) |
|-----|-------|------|------------------------|
| **P0** | API1:2023 BOLA | Cross-tenant data leak | Centralized server-side `tenantId` predicate on **every** Firestore/BigQuery access; derive `tenantId` from verified host mapping; CI cross-tenant negative tests. **Do not rely on Firestore Rules** ([docs](https://docs.cloud.google.com/firestore/native/docs/security/get-started)). |
| **P0** | API3:2023 / A01 / A02 | Raw PII on public leaderboard | Mask **server-side before serialization** — field projection or **Sensitive Data Protection `deidentifyContent`** (`characterMaskConfig` for `EMAIL_ADDRESS`/`PHONE_NUMBER`/`LAST_NAME`); cache **only the masked** payload ([DLP](https://docs.cloud.google.com/sensitive-data-protection/docs/deidentify-sensitive-data)). |
| **P0** | A07 / API4 | Bot/spam signup flooding | reCAPTCHA Enterprise **server-side `createAssessment`** (verify `valid` + `action`), Firebase App Check, per-IP app rate limiting, **double opt-in** email verification, **Email Enumeration Protection** (default-on for projects ≥2023-09-15) ([recaptcha](https://docs.cloud.google.com/recaptcha/docs/create-assessment-website)). |
| **P0** | A05 | Misconfig / LB bypass | If/when raw Cloud Run: disable default `run.app` URL (`--no-default-url`), set `ingress=internal-and-cloud-load-balancing`, enforce `run.allowedIngress` org policy. (`ingress=all` silently **disables VPC-SC**.) ([run ingress](https://docs.cloud.google.com/run/docs/securing/ingress)). |
| **P1** | A03 | Injection at the public edge | Cloud Armor preconfigured WAF **CRS 4.22** (`sqli-v422-stable`, `xss-v422-stable`, +`cve-canary`, `json-sqli-canary`), sensitivity 1 in **preview** first; note **64 kB** body-inspection limit ([waf-rules](https://docs.cloud.google.com/armor/docs/waf-rules)). *Post-MVP with self-managed ALB.* |
| **P1** | LLM01 / LLM02 / LLM06 | Prompt injection / output leak | **Model Armor** with **separate input + output templates** (PI/jailbreak at High); sanitize only the latest user message. **Gaps:** scans only first prompt + final response, and **fails open** — add an app-side hard check if compliance requires blocking ([model-armor](https://docs.cloud.google.com/model-armor/model-armor-vertex-integration)). |
| **P1** | A09 | Audit gap on tenant data / danger-zone ops | Enable **Data Access audit logs** (DATA_READ/DATA_WRITE — **off by default**) for Firestore/BigQuery/Secret Manager/KMS; immutable app audit record + typed confirmation for destructive ops; two-admin control for tenant deletion ([audit logs](https://docs.cloud.google.com/logging/docs/audit)). |
| **P1** | A08 / referral integrity | Replay-inflated rank | **Idempotent referral attribution**: transaction creating a create-only `(referrerId, refereeId)` edge doc + increment in the same transaction; reject `referrerId == refereeId` ([transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)). |
| **P2** | A10 / API7 SSRF & exfiltration | Agent reaches arbitrary endpoints | **Post-MVP:** internal-ingress Cloud Run + IAM `run.invoker` + VPC-SC perimeter around `firestore.googleapis.com` (restricted VIP `199.36.153.4/30`, deny-all egress firewall priority >1000) ([run vpc-sc](https://docs.cloud.google.com/run/docs/securing/using-vpc-service-controls)). |
| **P2** | A02 (at rest) | PII encryption | Firestore/Secret Manager (AES-256)/BigQuery are **already encrypted at rest by default**. CMEK only if a compliance driver exists; note CMEK does **not** cover data in transit/memory or Firestore metadata ([secret manager](https://docs.cloud.google.com/secret-manager/docs/overview)). |

**Disposable-email handling:** prefer a **maintained, server-refreshed blocklist** over an edge regex (brittle, false-positive-prone); rely on **verified double opt-in** to neutralize throwaways.

---

## 6. Cost Model & Traps

**At waitlist volumes, the platform is nearly free** — but specific traps will bite if the PRD's assumptions ship as-is.

| Item | Reality / Trap | Guidance |
|------|----------------|----------|
| **BigQuery sandbox** | The PRD's "free sandbox analytics" is **impossible** — sandbox blocks streaming/DML/DTS, tables expire 60 days. | Use a **Blaze, billing-enabled** project. Free *allowances* (1 TiB query, 10 GiB storage, 2 TiB/mo Storage Write API) still apply. |
| **Streaming ingestion** | Legacy `insertAll` = **$0.01 / 200 MiB, no free tier**. | Use **Storage Write API** ($0.025/GiB, first **2 TiB/mo free**) — effectively free at waitlist volume. |
| **BigQuery query scans** | $6.25/TiB after first 1 TiB/mo free. | **Partition by date + cluster by tenantId**; query the **latest view**, not raw JSON across all partitions. |
| **Firestore aggregation** | Live `count(score>userScore)` is cheap (**1 read** via the ≤1-range-field exemption) **but slow** — scales with dataset, 60s deadline. | Precompute rank via **distributed/sharded counters + CDN cache**; reserve `count()` for admin recompute. Never use `offset()` (billed per skipped doc) — use cursors. |
| **Firebase Extensions** | Require Blaze; ~$0.01/mo baseline per extension **plus per-invocation** Cloud Functions cost on every Firestore change event. | Acceptable at low volume; monitor invocation count as tenants scale. |
| **`minInstances ≥ 1`** | Billed continuously (lower idle rate with request-based billing). | Prod public backend `minInstances: 1` for latency; dev `0` for zero idle. Cap `maxInstances`. |
| **Direct VPC egress vs connector** | Connector = always-on VM (min ~2 e2-micro 24×7) + egress. | Direct VPC egress = **egress only, scales to zero** — direct savings. |
| **Unauthenticated public endpoints on Blaze** | Bandwidth/abuse can drive **unbounded spend**; budget alerts **do not cap**. | Add a **programmatic billing-disable safeguard function**, budget alerts, aggressive CDN caching, reCAPTCHA + App Check. App Hosting bandwidth ($0.15–0.20/GiB) is the dominant lever at 1M+ visits → **maximize CDN cache-hit rate**. |
| **reCAPTCHA Enterprise** | First **10k assessments/mo free**; billing unlocks all 11 score levels. | Sufficient for MVP signup volume. |

**Order-of-magnitude:** App Hosting ≈ **$0.01 at 10k visits/mo**, ≈ **$70 at 1M visits/mo** (bandwidth-dominated). Firestore + BigQuery + Cloud Tasks stay within free allowances at MVP scale. Plan budget for Blaze billing, not a zero-dollar sandbox.

---

## 7. Phased Delivery Roadmap

### Phase 0 — Foundations
- **Scope:** Two GCP/Firebase projects (`-dev`, `-prod`, **Blaze**); monorepo aligned with `vizzybl-portal` (Next.js 15, React 18, TS 5.6, Zod, Vitest, Tailwind); App Hosting backends + `apphosting.{env}.yaml`; CI (lint, typecheck, Vitest); per-service least-privilege SAs; Secret Manager.
- **Key services:** App Hosting, Cloud Build, Secret Manager, IAM.
- **Security gates:** org policies (`iam.disableServiceAccountKeyCreation`, `iam.automaticIamGrantsForDefaultServiceAccounts`); budget alerts + billing-disable safeguard; lint rule banning raw `db.collection()`; **centralized tenant-aware repository scaffold landed before any feature code**.

### Phase 1 — Waitlist Signup + Hosted Page
- **Scope:** Public per-tenant landing page; signup API (idempotent, deterministic doc ID); host-header→tenantId mapping; double opt-in (Identity Platform email verification); admin portal shell (GCIP tenants, Normal/Admin RBAC).
- **Key services:** Firestore (single DB + tenantId), Identity Platform, reCAPTCHA Enterprise (app-layer), App Check, Cloud Tasks (verification email).
- **Security gates:** server-side `createAssessment` (verify `valid` + `action`); Email Enumeration Protection on; Firestore Rules `if false` backstop; CI cross-tenant negative test; PII never sent to client.

### Phase 2 — Leaderboard + Referrals + Analytics Pipeline
- **Scope:** Leaderboard (precomputed rank via sharded counters), referral attribution (transactional, idempotent, self-referral rejected), corrected score formula (integer seconds + re-weighted/two-field order), Firestore→BigQuery extension + backfill, partitioned/clustered changelog, per-tenant authorized views.
- **Key services:** Firestore distributed counters, Cloud CDN, firestore-bigquery-export (Blaze), BigQuery, Storage Write API path.
- **Security gates:** leaderboard endpoint anonymous + cookie-free + PII-masked before cache; `tenantId` promoted to typed BQ column; de-dup/ordering on changelog; verify CDN cache-hit ratio under load; rank query ≤1 range field.

### Phase 3 — Q&A Surveys + Admin Dashboard
- **Scope:** Q&A survey capture (answers map in Firestore → JSON `data` column, projected via `fs-bq-schema-views`); analytics dashboard over authorized views; danger-zone destructive ops.
- **Key services:** BigQuery views (`JSON_VALUE`/`JSON_QUERY`), App Hosting admin backend, Sensitive Data Protection.
- **Security gates:** **Enable Data Access audit logs**; typed-confirmation + immutable app audit record + two-admin control for destructive ops; dashboard queries scoped to tenant-clustered partitions.

### Phase 4 — Agentic Email Hub
- **Scope:** **Single ADK `LlmAgent`** in-process on the existing Cloud Run/App Hosting runtime, calling `gemini-2.5-flash`/`gemini-3.5-flash` via `@google/genai`; Cloud Tasks-driven blast queue (idempotent, chunked).
- **Key services:** `@google/genai`, ADK (TS), Model Armor (project floor settings, `INSPECT_ONLY` → `INSPECT_AND_BLOCK`), Cloud Tasks, Cloud Scheduler.
- **Security gates:** Model Armor separate input/output templates (PI/jailbreak High); app-side hard check given fail-open; pinned model ids + retirement-date runbook; no `tenantId` in prompts (isolation via IAM + server predicates).
- **Explicitly deferred beyond Phase 4 (gated on multi-agent milestone):** Agent Runtime/reasoningEngines, Agent Identity, A2A, Memory Bank, the Market Intelligence agent (BigQuery `AI.GENERATE_TEXT` bound to a current Gemini id), full VPC-SC perimeter, internal-only Cloud Run + self-managed ALB + Cloud Armor.

---

## 8. Open Questions for the Founder

1. **Edge WAF at launch?** Do the public signup/leaderboard endpoints need Cloud Armor + reCAPTCHA-WAF **at MVP**, or is app-layer reCAPTCHA sufficient? This decides **App Hosting (lean) vs raw Cloud Run + self-managed ALB (heavy)** — the single biggest footprint fork.
2. **Compliance driver for VPC-SC / CMEK?** Is there an enterprise/GDPR/SOC2 requirement that mandates a data-exfiltration perimeter or customer-managed keys at launch? If no, both are correctly **deferred**.
3. **Org-level vs standalone project?** VPC-SC requires an **Organization** + org-level access policy. A standalone `vizzybl-marketing` project can't create a perimeter the documented way — confirm the org structure if a perimeter is ever planned.
4. **Expected tenant count & growth rate?** This determines single-DB-vs-dataset-per-tenant, and whether the 100-database / 2,500-authorized-resource / 100-service-account limits bite.
5. **Referral weighting intent?** Should referrals **dominate** rank (timestamp only breaks exact ties), or is the current ~8.3-min-per-referral weighting intentional? Drives the score formula rewrite.
6. **Leaderboard freshness & depth.** Is a **1–5 min stale** rank acceptable (lets us serve from cache/rollups and remove the live `count()` from the hot path)? How deep must exact ranks go?
7. **PII fields & masking spec.** Exactly which PII is collected at signup (phone? last name? company? survey answers?), and what is the precise per-field masking rule for the public leaderboard?
8. **TS-only agents?** Stay TypeScript (`@google/adk`, no ADK 2.0 graph engine) for the single Email Hub agent, or stand up a separate Python ADK 2.0 service for future graph/multi-agent workloads?
9. **Dashboard real-time requirement.** Does analytics need sub-minute freshness (justifying streaming + monitoring) or is minutes-level latency acceptable (cheaper, avoids streaming-insert nuances)?
10. **PII erasure policy for BigQuery.** A Firestore delete does **not** erase the BigQuery copy (changelog + time-travel + CDC delete window). What is the required erasure SLA, and do we need an explicit purge process + reduced time-travel window?