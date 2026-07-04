# Distribute Module — Full Phase-by-Phase Build-Out Plan

Grounds the two Distribute spec docs (`YouGrow.AI - Distribute PRD.md`, `YouGrow.AI - Distribute tab.md`) against the
existing codebase and sequences the build. Owner decisions: build the full automation as specified; X delivery uses the
X MCP where possible; the LinkedIn DM/connect automation is isolated last behind its compliance gate.

## Context

The **Distribute** pillar of the Workspace / Content OS is today only a `<StubPage>`
([distribute/page.tsx](src/app/admin/workspace/[workspaceId]/distribute/page.tsx)). The PRD describes a 4-epic outbound
engagement suite: (1) multi-channel scheduling + native previews + copy engine, (2) predictive scoring + closed feedback
loop, (3) inbound social-lead CRM, (4) outbound engagement/orchestration.

## Grounding — what we reuse (verified paths)

- **Publish payload already exists** — [contentPlan.ts](src/lib/types/contentPlan.ts): each `ContentNode` carries
  `{channel, format, body, scheduledAt, status:"approved"}`; `ContentPlan.status` has `"scheduled"`. Node→post is 1:1.
- **Channels + preview rules** — [channels.ts](src/lib/content/channels.ts) (X ≤280, LinkedIn "see more", IG one-idea/slide;
  formats `x-thread`, `linkedin-carousel`, `instagram-carousel`). **Transform seed** —
  [transformationMatrix.ts](src/lib/content/transformationMatrix.ts) + [deconstruct.ts](src/lib/content/deconstruct.ts).
- **Idempotent queue to clone** — [emailJob.ts](src/lib/types/emailJob.ts) (dedupeKey=doc id, `pending/processing/done/failed`,
  `attempts`, `claimedAt` lease, `MAX_ATTEMPTS`, `scheduledAt`), worker [delivery.ts](src/lib/email/delivery.ts), endpoint
  [jobs/process/route.ts](src/app/api/admin/email/jobs/process/route.ts) (dual caller), "enqueue-without-kick"
  [broadcasts/.../schedule/route.ts](src/app/api/admin/campaigns/[campaignId]/broadcasts/[broadcastId]/schedule/route.ts),
  cron provisioner [infra/email-worker/setup.sh](infra/email-worker/setup.sh).
- **Tenant registry** — [repository.ts](src/lib/tenant/repository.ts): `TenantCollection<T>` + `forTenant()` (regional DB).
- **Social OAuth to clone** — [providers.ts](src/lib/integrations/providers.ts), start/callback routes,
  [crypto.ts](src/lib/integrations/crypto.ts) (AES-256-GCM), `GitConnectionSchema` on tenant doc
  ([tenant.ts](src/lib/types/tenant.ts)).
- **RAG / vector** — [knowledgeRetrieval.ts](src/lib/agents/knowledgeRetrieval.ts) (`findNearest` COSINE) +
  [embeddings.ts](src/lib/agents/embeddings.ts); pinned `text-embedding-005`/768-dim.
- **Agents** — [root agent.py](agents/root_agent/agent.py) + [campaign_ops](agents/root_agent/sub_agents/campaign_ops/agent.py);
  canvas [route](src/app/api/agent/canvas/route.ts) + [registry.ts](src/lib/canvas/registry.ts) + [auth.ts](src/lib/canvas/auth.ts).
  Models centralized in [modelConfig.ts](src/lib/agents/modelConfig.ts) + [model_config.py](agents/root_agent/model_config.py).
- **Webhook + analytics to mirror** — [webhooks/mandrill/route.ts](src/app/api/webhooks/mandrill/route.ts),
  [emailEvent.ts](src/lib/types/emailEvent.ts), [analytics/email.ts](src/lib/analytics/email.ts), Analytics UI
  [analytics/page.tsx](src/app/admin/launches/[campaignId]/analytics/page.tsx).
- **Google/Firebase (Dev Knowledge MCP):** Cloud Scheduler min = 1 min, overlapping invocations expected → drain must claim
  transactionally. `findNearest` supports `.where()` pre-filter (composite vector index), ≤2048 dims, ≤1000 results. Gemini
  image models (`gemini-3-pro-image` "Nano Banana Pro"/`gemini-2.5-flash-image`, `responseModalities:[TEXT,IMAGE]`). App
  Hosting secrets need the grant-access triple in `apphosting.*.yaml`.

## Pinned shared contracts (every phase references these exact names)

- **Collection `campaign_scheduled_posts`** — `src/lib/types/scheduledPost.ts` → `ScheduledPostSchema`/`ScheduledPost`:
  `{ id (=dedupeKey), tenantId, workspaceId, contentPlanId, nodeId, channel, format, jobKind, status:'pending'|'processing'|'done'|'failed', dedupeKey, scheduledAt (ISO), attempts, claimedAt?, body, spintaxSource?, renderedVariant?, threadParts?, carouselAssetRefs?, pps?, autoPlug?, publishedRef?, lastError?, createdAt, processedAt? }`.
  `jobKind ∈ 'publish' | 'auto_plug_comment' | 'auto_engage_draft' | 'auto_dm' | 'performance_fetch' | 'li_connection_request' | 'li_dm_held' | 'li_dm_release'`. Same idempotency invariants as `email_jobs` (doc id = dedupeKey, atomic create, claim + `claimedAt` lease, `MAX_ATTEMPTS`, `publishedRef` guard on retry — mirrors `emailSentAt`/`mandrillMessageId`).
- **Worker** — `src/lib/distribute/scheduler.ts`: `processScheduledPosts(ctx, limit)` + `processScheduledPostsForAllTenants(limitPerTenant)`. **Endpoint** `src/app/api/admin/distribute/posts/process/route.ts` (dual caller; secret `DISTRIBUTE_WORKER_SECRET`). **Enqueue** `src/app/api/admin/workspace/[workspaceId]/distribute/schedule/route.ts`.
- **Registry** — add `scheduledPosts: TenantCollection<ScheduledPost>` (collection `campaign_scheduled_posts`) + `socialEvents` to `TenantRepositories` + `forTenant()` (regional DB).
- **Social connections** — `socialConnections` map on the tenant doc (mirrors `gitConnections`/`GitConnectionSchema`), encrypted with `SOCIAL_TOKEN_ENC_KEY`. Providers via `src/lib/social/providers.ts`: `x`, `instagram`, `linkedin`.
- **Social engagement** — `src/lib/types/socialEvent.ts` → collection `social_events` (mirrors `emailEvent.ts`); a `socialProfile` sub-structure on `Contact` (`{platform, handle, name?, bio?, location?, followers?, following?}`) + `searchTokens`.
- **Feedback + scoring** — `src/lib/distribute/pps.ts` (pure); `performance_exemplar` chunk kind in `knowledge_bases`; `src/lib/distribute/feedback/{recordExemplar,retrieveExemplars}.ts`.
- **Agents** — `agents/root_agent/sub_agents/outreach_ops/agent.py`; canvas kinds in `src/lib/canvas/kinds/` (`outreachReply.ts`, `outreachDm.ts`) registered in `registry.ts`. Carousel image model added to `modelConfig.ts`.

## Early architectural decisions

- **D1** New `campaign_scheduled_posts` collection (reuse the *mechanism*, not the `email_jobs` table — post state is genuinely different + extends 48h past publish).
- **D2** New cron worker at **60s** (`* * * * *`); overlap-safe via transactional claim/lease.
- **D3** PPS is a **pure deterministic TS lib**, scored live in preview + re-checked at enqueue; the 48h loop is async in the worker.
- **D4** Closed loop injects at **retrieval** (namespaced `performance_exemplar` chunks + `findNearest` pre-filter), not fine-tuning; cap exemplar count (anti-poisoning).
- **D5** Outreach drafting = **`outreach_ops` sub-agent + canvas kinds**, never inline model calls.
- **D6** Idempotent publish via atomic `publishedRef` set + retry check.
- **D7** Residency split: social tokens on the tenant doc (control-plane); `social_events` + Engaged PII in the **regional** DB.

## Execution model — every slice runs the same mandatory quality loop

Non-negotiable, applied to EVERY slice of EVERY phase (the repo's standing practice):

1. **Branch** off `dev` per slice (a phase = 1–4 slices). Stage specific files (never `git add -A`).
2. **Build** the slice.
3. **Test alongside the code:** unit tests for all new logic against the in-memory Firestore fake — queue
   claim/lease/retry/idempotency, PPS rubric, spintax/thread/preview boundaries, webhook signature parsing, tenant-isolation.
   Route/integration tests for new endpoints. **No slice merges without meaningful tests for its new logic.**
4. **Adversarial multi-agent review (verify findings):** `/code-review` (escalate to `/code-review ultra` for the
   money-/security-sensitive slices: Phase 4+ tokens, webhooks, publishing). Treat every finding as a hypothesis → verify it
   against the code before acting; fix the real ones, dismiss false positives with a note; **re-review after fixes**.
5. **Security review** (`/security-review`) — MANDATORY for any slice touching auth, token encryption, webhooks, external
   fetch, or cross-tenant data (all of Phases 4–6).
6. **Green the gates:** typecheck + lint + all tests pass; local smoke on `:3002` (emulators); deploy
   `firestore.indexes.json`; provision secrets (grant-access triple + `apphosting.*.yaml`).
7. **Merge → deploy dev → smoke on deployed dev.** Promote to `main`/prod later via the `--no-ff` release.
8. Ship gated/uncertain surfaces **behind a flag OFF by default** (`DISTRIBUTE_SOCIAL_ENABLED`) until provisioned.

A slice is "done" only after step 7's deployed-dev smoke passes. No phase past 3 starts until its GATE row is provisioned.

---

## Phase 1 — Scheduling Core & Native Previews  *(buildable now, no external API)*
**Objective:** replace the Distribute stub with a working scheduler: read approved Create nodes, schedule them onto a
calendar/list, persist to an idempotent queue drained by a 60s cron, and render platform-native previews. Publish is a
placeholder ("mark/export") until Phase 4.

**Slice 1a — Queue backend + cron.** `scheduledPost.ts` type; register `scheduledPosts` in `repository.ts`;
`src/lib/distribute/scheduler.ts` worker cloned from `delivery.ts` (claim `pending` where `scheduledAt ≤ now` → `processing` +
`claimedAt`; reclaim stale leases; success → `publishedRef` + `done`; retry to `MAX_ATTEMPTS` then `failed`; Phase-1 publish =
manual stamp); process endpoint (`DISTRIBUTE_WORKER_SECRET`); workspace schedule endpoint (enqueue without kicking);
`firestore.indexes.json` `(tenantId,status,scheduledAt)`; `infra/distribute-worker/setup.sh` (`* * * * *`); secret in apphosting yamls.

**Slice 1b — Distribute UI shell.** Replace the stub with a server page loading `ready`/`scheduled` plans + scheduled posts;
`DistributeClient` (Calendar|List), `CalendarView` (drag-to-reschedule), `ListView`; GET/PATCH/DELETE on the schedule route.

**Slice 1c — Platform-native previews.** Pure libs `src/lib/distribute/preview/{x,linkedin,instagram}.ts` (X 280 split + thread;
LinkedIn "see more"; IG grid) + preview components in the node inspector + calendar.

**Review & test focus (adversarial):** double-publish + lease races under overlapping cron runs; worker-secret compare + fan-out
auth; tenant isolation on `campaign_scheduled_posts`; reschedule/delete authz; `scheduledAt` timezone handling; preview
boundaries. **Exit:** approved nodes render platform-accurate previews and schedule onto the calendar; a scheduled post is an
idempotent `campaign_scheduled_posts` doc; the cron drains under a lease with no double-processing.

## Phase 2 — Copy Engine: Spintax + Thread Deconstructor + Carousel Builder  *(no social API)*
`src/lib/distribute/spintax.ts` (bounded recursive `{a|b|c}`, seedable); `threadDeconstructor.ts` (wraps `deconstruct.ts` →
ordered `threadParts[]`); carousel: env-overridable image model in `modelConfig.ts` + `carousel/build.ts` + private-bucket
app-proxy route; `autoPlug` rule definition on the post type; UI `{SpintaxEditor,ThreadDeconstructorPanel,CarouselBuilder}`.
**Prereqs:** Vertex image model + `GOOGLE_CLOUD_LOCATION=global` + vertexPredictor SA + private carousel bucket.
**Review & test focus:** unbounded spintax expansion (DoS) — assert caps; SSRF + auth on the asset proxy; bucket privacy; model
id not hard-coded; thread-split edge cases. **Exit:** preview N variants; hub → correct X thread; carousel → private PDF; Auto-Plug rules save.

## Phase 3 — Predictive Score (PPS) + Closed-Loop plumbing  *(no social API)*
`src/lib/distribute/pps.ts` (pure weighted scorer, live in preview + re-checked at enqueue); `performance_exemplar` chunk kind +
`feedback/recordExemplar.ts` (embed → `knowledge_bases`) + `feedback/retrieveExemplars.ts` (`findNearest` + `.where(kind)` +
channel pre-filter, injected into Create generation, capped); worker `performance_fetch` job at `publishedAt + 48h` (engagement
adapter stubbed until Phase 4/5); PPS gauge + exemplar attribution UI. **Prereqs:** COLLECTION-scope vector index for the
exemplar pre-filter. **Review & test focus:** exemplar poisoning caps; no PII in embedded text; embedding residency; index
correctness; PPS determinism. **Exit:** live 0–100 PPS per draft; exemplar write→retrieve; generation cites a seeded exemplar.

## Phase 4 — X (Twitter) live channel  *(access-tiered; MCP fast-path, not a hard paywall)*
**Delivery references:** [x-api/llms.txt](https://docs.x.com/x-api/llms.txt) (post/mentions/search/stream/DMs/user-lookup/
Webhooks + Account Activity); [x-ads-api/llms.txt](https://docs.x.com/x-ads-api/llms.txt) is paid-ads only (skip). **Prefer the
X MCP** (official XMCP + community servers wrap posting/search/engagement/user-lookup — no custom OAuth client); the MCP excludes
streaming + webhooks, so the sniper's monitoring + comment-trigger webhooks use the direct API.
1. Social OAuth + `socialConnections` (clone git OAuth, `SOCIAL_TOKEN_ENC_KEY`) — skippable if the MCP manages auth.
2. `src/lib/social/x/client.ts` publish adapter over the X MCP (or direct API); wire into the worker `publish` jobKind.
3. Engagement webhook `src/app/api/webhooks/x/route.ts` (CRC + verify) → `social_events`; analytics section.
4. CRM Engaged tab: `socialProfile` on `contact.ts` + `EngagedView.tsx` (HANDLE/NAME/BIO/LOCATION/FOLLOWERS/FOLLOWING + DM).
5. NL lead finder (`embedQuery` + `findNearest` + follower filter). 6. Auto-Plug firing. 7. Auto-Engage sniper (draft →
   `SniperQueue`). 8. Comment→lead→DM funnel. 9. `outreach_ops` sub-agent + `canvas/kinds/{outreachReply,outreachDm}`.
**Access tiers:** Free (500 posts/mo) prototypes publish + Auto-Plug via the MCP; Basic (10k)/Pro (1M) for volume; streaming +
Account Activity need the direct API + higher tier. **⚠ Feb 2026: programmatic replies restricted on all self-serve tiers**
(reply only if the author @mentions/quotes you; Enterprise exempt) → sniper **drafts, operator posts** unless reply-eligible.
Auto-DM stays throttled + opt-in + human-in-the-loop. Secrets: `X_OAUTH_CLIENT_ID/SECRET`, `X_WEBHOOK_CONSUMER_SECRET`,
`SOCIAL_TOKEN_ENC_KEY`. Ship behind `DISTRIBUTE_SOCIAL_ENABLED` OFF.
**Review & test focus (SECURITY — `/code-review ultra` + `/security-review` mandatory):** token encryption round-trip; webhook
signature/CRC verify + replay; tenant isolation of tokens (control-plane) vs `social_events`/Engaged PII (regional); reply-
eligibility enforcement; auto-DM throttle/opt-in; NL-finder query injection; idempotent publish via `publishedRef`.
**Exit:** connect X → real publish; engagement → Engaged; Auto-Plug fires; sniper drafts within ~60s (operator posts unless
reply-eligible); a "Growth" comment → lead + operator-gated DM; PPS loop gets real X engagement.

## Phase 5 — Instagram live channel  *(GATE: Facebook App Review)*
`src/lib/social/instagram/client.ts` (Graph content-publishing — carousels reuse Phase 2 — + Messaging); provider +
`socialConnections` entry; `webhooks/instagram/route.ts`; extend Engaged + closed loop to IG. **GATE:** Business/Creator +
Facebook App Review (content_publish, messaging; start during Phase 4). Secrets `META_APP_ID/SECRET`, `IG_WEBHOOK_VERIFY_TOKEN`.
**Review & test focus (SECURITY mandatory):** Graph token scope + encryption; webhook verify + replay; Phase-4 isolation/residency
assertions; carousel publish idempotency; DM opt-in/throttle. **Exit:** IG carousel/caption publish; IG engagement → Engaged +
closed loop; IG DM from Engaged.

## Phase 6 — LinkedIn  *(GATE: partner approval; then HARD compliance gate)*
- **6a (buildable behind partner approval):** `src/lib/social/linkedin/client.ts` (Community Management / Marketing Developer
  Platform organic posting) + provider + webhook; the Phase-1 cron solves LinkedIn's missing native schedule param. **GATE:** LinkedIn partner approval.
- **6b (DESIGN-ONLY until unblocked):** Intent Orchestrator state machine (`li_connection_request`, `li_dm_held`,
  `li_dm_release`; 1st-degree → queue DM; non-connected → connection request → hold DM → deliver on acceptance). **HARD compliance
  blocker:** member-to-member DMs + connection requests are not exposed by the official API; automating them violates the
  LinkedIn User Agreement. Ship as **draft-and-remind** (app drafts + reminds, human sends) unless/until an approved path is chosen.
**Review & test focus (SECURITY + COMPLIANCE mandatory):** the review must assert 6b **cannot auto-send** while in
draft-and-remind mode; token encryption + tenant isolation as Phase 4; organic-post idempotency.
**Exit (6a):** LinkedIn organic posts publish on schedule; engagement → Engaged + closed loop. **Exit (6b):** compliant-path
go/no-go recorded; if no-go, orchestrator degrades to draft-and-remind.

---

## Sequencing rationale
Phases 1–3 carry **zero external dependency** and deliver the core value — de-risking the module and enabling an early demo.
Phase 4 (X) is first among external channels: fullest automation surface via official APIs, a free tier + off-the-shelf MCP
(cheapest to start), and it validates the whole outbound/inbound/closed-loop architecture while building every reusable social
primitive. Phase 5 (Instagram) reuses those primitives while its App-Review gate runs in parallel. Phase 6 (LinkedIn) is last
because its headline automation has no compliant API path.

## Platform access & compliance prerequisites (consolidated)

| Item | Type | Blocks |
| --- | --- | --- |
| `DISTRIBUTE_WORKER_SECRET` + Cloud Scheduler `* * * * *` | secret + infra | Phase 1 |
| Firestore indexes: `campaign_scheduled_posts`, `social_events`, social-profile CRM, `performance_exemplar` vector | indexes | 1, 3, 4 |
| Vertex image model + `GOOGLE_CLOUD_LOCATION=global` + vertexPredictor SA + private carousel bucket | IAM/model/infra | Phase 2 |
| X access tier (Free 500/mo to start; Basic/Pro for volume) + **X MCP**; direct API + Account Activity only for streaming/webhooks | access-tiered (not a hard paywall) | Phase 4 |
| ⚠ Feb 2026: programmatic replies restricted on all self-serve X tiers (Enterprise exempt) → sniper drafts, operator posts | compliance constraint | Phase 4 |
| X secrets (`X_OAUTH_*`, `X_WEBHOOK_CONSUMER_SECRET`, `SOCIAL_TOKEN_ENC_KEY`) + auto-DM throttle/opt-in/human-in-loop | secrets + compliance | Phase 4 |
| **Instagram Graph API: Business/Creator + Facebook App Review** | **partner review — GATE** | **Phase 5** |
| **LinkedIn Community Mgmt / Marketing Developer Platform partner approval** | **partner approval — GATE** | **Phase 6a** |
| **LinkedIn DM + connection-request automation** | **HARD compliance blocker (no official API; violates User Agreement)** | **Phase 6b** |
