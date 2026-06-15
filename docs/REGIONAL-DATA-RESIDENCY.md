# Regional Data Residency — Architecture & Phase-0 Readiness

*Prepared 2026-06-15. Every non-trivial claim is grounded in a current Google doc URL; items I could not fully verify are marked **unverified**.*

## 1. Feasibility verdict

**Yes — your "a database backend in US, one in EU, one in Asia" is achievable today on GA Google products, with one correction and one shape.** The correction: there is **no Asia multi-region**. US and EU get replicated multi-region backends (5-nines); Asia must be a single region (4-nines). The shape: **one Firebase project, multiple *named* Firestore databases — one per region — selected at request time by a `region` field on the tenant**, with a per-region BigQuery dataset for analytics. This is exactly the pattern your sibling app `vizzybl-portal` already ships in production (`/Users/jezlloyd/vizzybl-portal/functions/src/db.ts`), which de-risks the work to "copy a proven shape." The one thing you must do **now** — before any production data exists — is thread an immutable `region` through Phase 0, because Firestore database location is immutable and region is as expensive to retrofit as `tenantId`. You can ship that region-readiness while provisioning only the US database.

## 2. The Google constraints that drive the design

| Constraint (verified) | Implication for vizzybl-marketing |
|---|---|
| **A database's location is immutable** — "once you provision a database, you cannot change its location setting." ([firestore/locations](https://firebase.google.com/docs/firestore/locations)) | Region must be chosen at tenant-creation and treated as **write-once**. Wrong region = export+reimport into a new DB, not a "move." This is *the* reason region must land in Phase 0. |
| **No Asia multi-region.** The only multi-regions are `nam5`/`nam7` (US) and `eur3` (EU). Asia is regional-only — `asia-southeast1` (Singapore), `asia-northeast1` (Tokyo), `asia-south1` (Mumbai). ([firestore/locations](https://firebase.google.com/docs/firestore/locations)) | US/EU tenants get **≥99.999%** SLA and survive full-region loss; Asia gets **≥99.99%**, survives only zone loss, **no cross-region failover**. Asymmetry to communicate, not a bug. ([locations SLA table](https://firebase.google.com/docs/firestore/locations)) |
| **No cross-database / cross-location queries or transactions.** A Firestore connection is limited to one database; BigQuery refuses any job whose datasets span different locations, and "single-region ... don't match multi-region locations, even where the single-region location is contained within the multi-region." ([bigquery/locations](https://docs.cloud.google.com/bigquery/docs/locations), [data-replication](https://docs.cloud.google.com/bigquery/docs/data-replication)) | A global leaderboard across regions **cannot be one query**. It must be app-side fan-out-and-merge, or a separate aggregation store. Referral-credit transactions only work *within* one region. Drives the **per-tenant** model in §4. |
| **"Residency" = data **at rest**, by contract.** Google's data-residency commitment covers Customer Data at rest (and in-use by the configured service) for services configured to a region/multi-region; it explicitly **excludes** resource identifiers, attributes, and metadata. ([assured-workloads/data-residency](https://docs.cloud.google.com/assured-workloads/docs/data-residency)) | At-rest in-region satisfies the common GDPR-style bar. US compute reading an EU DB keeps EU rows at-rest in the EU but **does** transit them to the US (a Restricted European Transfer covered by Google's SCCs/DPF — not an automatic violation). In-transit/in-use residency is a *separate, stronger* control requiring regional endpoints + regional compute. **Don't encode PII into doc/database IDs** — metadata isn't covered. |
| **Only one free database per project; the rest bill from op #1 and need Blaze.** ([firestore/pricing](https://firebase.google.com/docs/firestore/pricing)) | US+EU+Asia = at most 1 free + 2 billed DBs. Backups/PITR also have no free tier. Move to Blaze before launch. |
| **Rules, indexes, backups, PITR are per-database; backups stay in the source location.** Max 100 DBs/project. Cloud Functions v1 can't trigger named DBs — use 2nd-gen triggers, one per regional DB. ([manage-databases](https://firebase.google.com/docs/firestore/manage-databases)) | Per-region operational config multiplies. Deploy rules+indexes to **all** DBs in CI; never hand-edit one region. DB-per-tenant is ruled out (100 cap + 1-free rule). |
| **`getFirestore(app, databaseId)` still carries a "preview / Do not use in production" banner** in the current (mid-2026) firebase-admin Node reference. ([firebase-admin.firestore](https://firebase.google.com/docs/reference/admin/node/firebase-admin.firestore)) | **This is current, not stale** — I re-verified it today. *However*, the multiple-databases feature is GA, and your own `vizzybl-portal` ships this exact call in production. Treat the banner as a documentation lag, pin your firebase-admin version, and note the proven workaround: **`db.settings({ databaseId })` does NOT work — you must use `getFirestore(app, databaseId)`** (documented verbatim in the sibling `db.ts`). |

## 3. Recommended regional backend structure

**Adopt: multiple named Firestore databases in your *single existing project* — one per region — plus one same-region BigQuery dataset per region.** "Data regionalization" is the documented, supported use case for multiple databases. ([manage-databases](https://firebase.google.com/docs/firestore/manage-databases))

Concrete layout, matching the proven sibling config:

| Region | Firestore DB id | Firestore location | Type | BigQuery dataset location |
|---|---|---|---|---|
| `us` (default) | `(default)` / `signups-us` | `nam5` | multi-region, 5-nines | `US` multi-region |
| `eu` | `signups-eu` | `eur3` | multi-region (in-EU), 5-nines | `EU` multi-region |
| `asia` | `signups-asia` | `asia-southeast1` (Singapore) | **single region**, 4-nines | `asia-southeast1` |

*Use logical-region DB ids decoupled from physical location (`signups-eu`, not `eur3`) so the physical location stays swappable in the map.*

**vs project-per-region:** project-per-region buys hard billing/trust isolation and lets each region have its own App Hosting backend and IAM boundary — but it multiplies ops (separate IAM, config, deploy, org-policy scope) for no MVP benefit. **Tradeoff verdict: one project + named DBs.** Reach for project-per-region only if a customer contractually demands a hard trust/billing boundary per region. Within one project you still get per-database IAM scoping via IAM Conditions on `resource.name` for defense-in-depth.

## 4. Two residency models — PER-TENANT (recommended) vs PER-END-USER

| Dimension | **PER-TENANT (brand residency)** ✅ adopt | **PER-END-USER (signer residency)** ❌ defer |
|---|---|---|
| Rule | Each brand is pinned to one region; **all** its campaigns + signups live in that region's DB. | Each signup is stored in the **end-user's** region; one campaign is split across 3 DBs. |
| Leaderboard | Single-DB query/aggregation. Simple, one read path. | Every leaderboard = fan-out of N paginated queries + app-side merge; **no global `ORDER BY rank`**, no single `count()`. |
| Referral graph | Token issue + redeem + credit all intra-DB → can use a **Firestore transaction** (atomic). A US user referring an EU user into the *same brand's* campaign still lands intra-DB. | Token issued in EU, redeemed by a US user lands in a *different* DB → cross-region token lookup, **non-atomic** credit (no transaction spans DBs). |
| Analytics | One region = one dataset = clean partition. | Per-campaign analytics is itself cross-region. |
| Cost/latency | One read per leaderboard load. | N regional reads + merge per page; multiplies read cost and latency. |

**Decision: PER-TENANT for the MVP.** It makes the leaderboard, referral graph, and analytics each a single-database operation — which is the only shape that's cheap and atomic given the no-cross-DB-query constraint (§2). Per-end-user residency is a much larger build and is only warranted if a regulator mandates **end-user** (not brand) residency. Don't revisit it until that requirement is real.

## 5. Request routing

**Host → tenant → region → databaseId → DB client.** The global `tenants` registry is the chicken-and-egg root: you must read it *before* you know the region, so it has a **fixed home** and is never region-resolved.

Flow on every public request:
1. Read `Host`/`Origin` → `getTenantByOrigin(origin)` against the **control-plane DB** (the `(default)` DB in `nam5`, holding only non-PII routing/config). Already implemented in `registry.ts`.
2. Read `tenant.region`.
3. `REGION_TO_DATABASE_ID[region]` → `databaseId`.
4. `getDb(databaseId)` for all campaign/signup/leaderboard access.
5. **Cache the host→tenant→region resolution** (immutable per tenant) so you don't pay the extra round-trip on every request.

**MVP topology — "data at rest in region, central compute":** one US App Hosting backend reads all three regional DBs. This satisfies the at-rest interpretation literally; EU/Asia tenants pay a cross-region round-trip per Firestore op (acceptable for a waitlist). App Hosting is GA in 6 regions (`us-central1, us-east4, us-east5, asia-east1, asia-southeast1, europe-west4`); a global CDN fronts it so cached/static responses serve from the edge regardless of backend. ([app-hosting/about](https://firebase.google.com/docs/app-hosting/about-app-hosting))

**Full regional cells — later:** co-located compute+data (one App Hosting backend per region behind your own global external ALB with one serverless NEG per region, Premium Tier) + Firestore **regional endpoints** for in-transit residency. Note global ALB / Cloud DNS geolocation route by **client** location, not the tenant's data region — so tenant→region resolution still must be in-app or via per-region hostnames. Trigger this only on a real latency SLA or a contractual in-use/in-transit requirement. ([serverless-neg-concepts](https://docs.cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts), [regional-endpoints](https://docs.cloud.google.com/docs/security/compliance/about-regional-endpoints))

## 6. Residency enforcement

Three layers, escalating with the compliance bar:

- **`gcp.resourceLocations` org policy (do this — P0).** A list constraint; set `allowedValues` with **value groups** (`in:us-locations`, `in:europe-locations`, `in:asia-southeast1-locations`) so new in-boundary regions don't unexpectedly widen/narrow the boundary. It **blocks creation** of out-of-region resources at runtime across Firestore, BigQuery, BQ Data Transfer, Cloud Functions, Cloud Storage. Two caveats: it applies **only to newly-created resources**, and it is **not a data-storage commitment** ("Organization policies that contain the resource locations constraint aren't data storage commitments") — the contractual guarantee lives in the Service Specific Terms. **Set it before provisioning** and audit with Security Health Analytics. ([restrict-locations](https://docs.cloud.google.com/organization-policy/restrict-locations)) Optionally add a Firestore **custom constraint** on `firestore.googleapis.com/Database` restricting `resource.locationId` (audit-logged, Firestore-specific). ([custom-constraints](https://docs.cloud.google.com/firestore/native/docs/custom-constraints))
- **Assured Workloads — NOT for the MVP.** Residency is fully achievable with org policy + EU/regional location selection alone. Assured Workloads adds vetted EU-personnel support and (in *Sovereign Controls* / EU Data Boundary, +~5% Premium) **data sovereignty** — CMEK enforcement, key-access justifications, restricted Google-personnel access, a jurisdictional console (`console.eu.cloud.google.com`). Adopt only if a customer requires **sovereignty**, not mere residency. Flag as a future enterprise add-on. ([assured-workloads](https://cloud.google.com/security/products/assured-workloads))
- **CMEK — sovereignty, not residency.** CMEK gives you key control (rotate/disable/destroy; with Cloud EKM you can deny Google decryption). Keys must be **co-located** with the data. CMEK does **not** change where data is stored. Defer unless sovereignty is required. ([bigquery CMEK](https://docs.cloud.google.com/bigquery/docs/customer-managed-encryption), [datastore CMEK](https://docs.cloud.google.com/datastore/docs/cmek))

## 7. Analytics across regions

**Per-region pipeline, no global warehouse.** For each region: 1 Firestore DB → 1 `firestore-bigquery-export` extension instance (Cloud Function co-located with the source DB; its trigger location must match the DB) → 1 **same-region** BigQuery dataset. This keeps PII in-region for free. ([bigquery-export](https://firebase.google.com/docs/projects/bigquery-export), [functions/locations](https://firebase.google.com/docs/functions/locations))

Because **cross-location JOINs are disallowed**, aggregate across regions by moving only **de-identified/aggregated metrics**, never raw PII:
1. Per-region scheduled query computes de-identified counts → copy those *small* aggregate tables into one reporting region via **BigQuery Data Transfer Service / dataset copy** (15-min min interval; copies all tables of a dataset). Safe because aggregates carry no restricted PII. ([managing-datasets](https://docs.cloud.google.com/bigquery/docs/managing-datasets))
2. Or **cross-region dataset replication** (`ALTER SCHEMA ... ADD REPLICA`) — async read-only secondary, billed as a separate storage copy, needs slots in the secondary region — **only** for data allowed to leave its region. ([data-replication](https://docs.cloud.google.com/bigquery/docs/data-replication))
3. Or accept per-region-only dashboards (simplest, zero residency risk).

**Hard rule: never replicate EU/Asia raw signup PII into a US reporting dataset — that breaks residency.** For the MVP, **per-region dashboards + a thin global aggregate of counts** is the right call. Note: scheduled queries are bound to their region and do **not** auto-failover on replica promotion — plan per-region jobs with documented manual failover. ([scheduling-queries](https://docs.cloud.google.com/bigquery/docs/scheduling-queries))

## 8. The minimal Phase-0 code change to be region-READY now

Make these four non-breaking changes now; **provision only the US database.** The map starts with one entry; lighting up EU/Asia later is "create the DB + add a map entry," zero schema migration — exactly how `tenantId` was front-loaded. Mirror the proven `vizzybl-portal` shape (`functions/src/region/types.ts`, `functions/src/db.ts`).

**(1) Add an immutable `region` to the tenant schema** — `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/types/tenant.ts`. Use a *logical* region enum (not a raw locationId) so physical location stays swappable:
```ts
export const Region = z.enum(["us", "eu", "asia"]);
export type Region = z.infer<typeof Region>;
// add to TenantSchema (required): region: Region,  // IMMUTABLE — set at creation, never updated
```

**(2) New pure resolver** — `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/regionMap.ts`. Start with only the home region:
```ts
import type { Region } from "@/lib/types/tenant";
// Logical region -> Firestore named-DB id. Add eu/asia entries when those DBs are provisioned.
export const REGION_TO_DATABASE_ID: Record<Region, string> = {
  us: "(default)",        // nam5, the only DB that exists today
  eu: "signups-eu",       // eur3        (not yet provisioned)
  asia: "signups-asia",   // asia-southeast1 (not yet provisioned)
};
export function databaseIdForRegion(region: Region): string {
  const id = REGION_TO_DATABASE_ID[region];
  if (!id) throw new Error(`No database mapped for region '${region}'`); // never silently default
  return id;
}
```

**(3) Make `getDb` accept a `databaseId` and cache per-id** — `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/firestore.ts`. The no-arg call keeps today's behavior. **Use `getFirestore(app, databaseId)` — `db.settings({databaseId})` does NOT work** (sibling-verified):
```ts
const clients = new Map<string, Firestore>();   // keyed by databaseId
export function getDb(databaseId = "(default)"): Firestore {
  const cached = clients.get(databaseId);
  if (cached) return cached;
  let app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const db = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
  try { db.settings({ ignoreUndefinedProperties: true }); } catch {}
  clients.set(databaseId, db);
  return db;
}
```
Because the map has one entry and `getFirestore(app, "(default)")` ≡ today's `getFirestore(app)`, this is a no-op for the current single-DB deployment.

**(4) Propagate `region` through the context and route the repository by it.**
- `TenantContext` (`src/lib/tenant/types.ts`): add `region: Region`.
- `resolveTenantFromOrigin` (`src/lib/tenant/context.ts`): return `{ tenantId: tenant.id, region: tenant.region, source: "host" }`. For admin requests, carry `region` on the verified claim or look it up from the registry.
- The repository's `forTenant(ctx)` factory should resolve `getDb(databaseIdForRegion(ctx.region))` and pass that into `TenantCollection` (which already takes a `db` in its constructor). **The `tenants`/`tenant_users` registry reads in `registry.ts` stay on the default control-plane DB** (`getDb()` no-arg) — they must be queryable before region is known.

**Two guardrails (high-severity in the findings):**
- **Region is required and non-defaulting.** `forTenant` must **throw** if `ctx.region` is absent/unmapped — a silent default would write a tenant's data into the wrong (US control-plane) DB and break residency invisibly. Mirror how `repository.ts` already refuses to change `tenantId`: reject `region` changes on the tenant write path.
- **Never write campaign/signup data to the control-plane DB.** It holds registry/config only.

## 9. Cost / latency notes and what's deferred

**Cost/latency:**
- Free tier covers **one** DB. US+EU+Asia = 2 billed DBs + backup/PITR storage (no free tier). Move to **Blaze** before launch. Per-op pricing varies by location; multi-region (`nam5`/`eur3`) costs more per op than the Asia single region, which buys 5-nines vs 4-nines. ([pricing](https://firebase.google.com/docs/firestore/pricing))
- Central US compute adds a cross-region round-trip + egress for EU/Asia tenants (trans-Atlantic ~80–130 ms, more trans-Pacific — **exact ms unverified** from Google docs; Google's guidance is just "store data close to users"). Mitigate by batching reads, denormalizing the signup write path, and caching host→tenant→region. ([firestore/locations](https://firebase.google.com/docs/firestore/locations))
- A fan-out leaderboard costs N regional reads per load; denormalize per-region counters via 2nd-gen triggers rather than live `count()` on hot paths (this reasoning is independent of residency).
- Cross-region BQ replication bills secondary-region storage as a separate copy plus replication egress and requires slots in the secondary region. ([data-replication](https://docs.cloud.google.com/bigquery/docs/data-replication))

**Deferred (pre-design the seams, don't build):** EU/Asia database provisioning until a tenant needs them; full regional compute cells (per-region App Hosting + global ALB + regional endpoints) until a latency SLA or in-transit/in-use requirement forces it; Assured Workloads / EU Data Boundary and CMEK until **sovereignty** (not residency) is contractually required; cross-region global analytics beyond a thin aggregate-of-counts; per-end-user residency unless a regulator mandates end-user (not brand) residency.

**Decisions the founder must make (immutable once chosen):**
1. **Which Asia region** — `asia-southeast1` (Singapore, what the sibling uses), `asia-northeast1` (Tokyo), or `asia-south1` (Mumbai)? Drive by target market + any in-country localization law.
2. **At-rest residency only, or in-transit/in-use too?** At-rest → central-compute MVP is fine. In-transit → gate launch on regional cells.
3. **EU multi-region `eur3` (recommended, 5-nines, in-EU) vs a single EU region?**
4. **Sovereignty needed** (CMEK / EU-only Google personnel)? If no → skip Assured Workloads for the MVP.

**Bottom line:** the architecture is sound and proven next door. Ship the four §8 changes now against the US database, set the `gcp.resourceLocations` org policy before you provision anything, adopt per-tenant residency, and you are region-ready with zero retrofit when EU/Asia tenants arrive.

---

*Relevant files: `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/firestore.ts`, `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/registry.ts`, `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/context.ts`, `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/types.ts`, `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/tenant/repository.ts`, `/Users/jezlloyd/antigravity/vizzyblmarketing/src/lib/types/tenant.ts`; proven reference: `/Users/jezlloyd/vizzybl-portal/functions/src/region/types.ts`, `/Users/jezlloyd/vizzybl-portal/functions/src/db.ts`.*