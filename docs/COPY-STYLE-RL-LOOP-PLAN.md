# Copy‑Style Reinforcement Loop — Implementation Plan

**Status:** Design approved, pre‑build. No code written yet.
**Owner:** Jez / Create pillar.
**Last updated:** 2026‑07‑24.

Learn a brand's unique **copy** style from the deltas between what the AI drafts and what the
operator actually approves (Final Copy **and** the brief), and feed it back so future generations
start closer to what the brand keeps. This is the **text mirror** of the image "brand style loop"
already in prod.

---

## 0. Locked decisions (founder, 2026‑07‑24)

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | **Keep a permanent 10–20 % injection‑OFF holdout** | Lift is only ever read as *injected − holdout*. Strongest guard against self‑consumption. |
| D2 | **Gate injection on *proven downstream performance*** | The reward bridge (correlationId → harvest → proven tier) is a **prerequisite for injection**, not a fast‑follow. Injection is enabled per **tenant × channel** only once that channel has published copy that cleared the tenant‑relative bar. |
| D3 | **Auto‑promote a new directive version once it passes the champion/challenger gate** | No human approval queue. The regression gate + operator veto/off switch are the guards. |
| D4 | **Written plan first (this doc), then build** | — |

> **Important implication of D2:** v1 injection only reaches channels that *publish and perform*
> (primarily X today, via the existing Distribute harvest). Email and low‑traffic tenants may stay
> in **learn‑dark** mode indefinitely until their channels get downstream harvest. This is the
> deliberate higher‑trust posture chosen in D2. Coverage widens as LinkedIn/email engagement
> harvest lands. See [Open items](#14-open-items).

---

## 1. Why this is a *proper* RL loop (not logging)

We cannot fine‑tune Gemini, so the **policy is the prompt‑conditioning we inject** — a synthesized
`learnedCopyStyle` directive plus (later) before→after preference exemplars. Policy "weights" live
in Firestore, per‑tenant, per‑region. This is exactly the shape the image loop already runs in prod
(`extractStyleProfile → refreshLearnedImageStyle → setTenantLearnedImageStyle → fenced injection`).

It qualifies as reinforcement/preference learning because it has all four parts of a closed loop:

1. **Policy** = injected directive + exemplar pairs → conditions the next draft.
2. **Explicit reward** (not a proxy‑by‑accident) = approval + edit magnitude + re‑edit churn +
   tenant‑relative downstream performance. Captured deltas are **reward‑weighted** at synthesis;
   reverted/forbidden phrasings become an explicit **AVOID** set (the analogue of image 👎).
3. **Reward model ⟂ policy** (RLHF factorization) = a versioned rubric + an LLM brand‑fit judge,
   each rule backed by independent‑support counts, separated from the conditioned generator.
   Best‑of‑N (final phase) optimizes each generation against that reward model at inference time.
4. **Measured control** = champion/challenger regression gate + a permanent holdout that proves
   causal lift, plus off‑policy credit assignment so a version can't reward itself.

```
   generateNode ──► AI draft  ("rejected" candidate)                 ┌── tenant.learnedCopyStyle
        ▲            │  ← snapshot this baseline server-side          │     (versioned directive
        │            │    (today it is overwritten & lost)            │      + per-channel fragments
        │            ▼                                                │      + support-counted rules)
        │        human edits ──► Final Copy ("chosen")  ──► DISTILL ◄─┤  + before→after pairs
   INJECT          + brief edits (machine → human)          │        │    (copy_edit_events, phase 6)
   (fenced,             │                                   │        │
   channel-scoped,      ▼                                   │  champion/challenger gate → auto-promote
   capped, tri-state,   REWARD ◄── approval + low re-edit + downstream X performance
   gated on proven)              (read only as injected − HOLDOUT; off-policy version tagging)
```

---

## 2. What we reuse (three existing substrates)

| Substrate | File(s) | Role in the copy loop |
|-----------|---------|-----------------------|
| **Image RL‑lite loop** | `src/lib/content/create/styleProfile.ts`, `brandStyleLoop.ts`, `src/lib/tenant/control.ts:79‑93` | The end‑to‑end template to clone (extract → synthesize → dotted persist → inject). |
| **Distribute performance closed loop** | `src/lib/distribute/feedback/{harvest,recordExemplar,retrieveExemplars}.ts`, `src/lib/tenant/exemplars.ts` | The **downstream reward** source (proven performers) **and** the regional‑collection + vector‑store pattern to clone for `copy_edit_events`. |
| **Brand voice grounding** | `src/lib/content/create/{brandContext,activeBrandVoice}.ts`, `src/lib/agents/prompts/compose.ts` | The single **injection seam**. Authored `tenant.brandVoice` stays **PRIMARY**; the learned directive is strictly secondary. |

---

## 3. Signals captured

| Signal | Where (verified anchor) | Notes |
|--------|-------------------------|-------|
| **Pristine AI draft** (the *rejected* candidate) | `…/nodes/[nodeId]/generate/route.ts` — `patch.body` before `updateContentPlanNode` | Written **server‑authoritatively** as a `status:'draft'` `copy_edit_events` row with a `draftNonce`. NOT stored on the node (avoids doubling `body` against the 1 MB doc limit). Client refs are an optimization only, never the sole source. |
| **Pristine auto‑brief** (machine baseline) | `…/nodes/[nodeId]/brief/route.ts` | Stamp `ContentNode.briefSource='machine'`; record into the same draft row. |
| **Human Final Copy** (*chosen*) + edited brief | `content-plans/[planId]/route.ts` **PUT** — loads OLD `plan` then `updateContentPlan(parsed.data)` | The only seam where pre‑ and post‑edit values coexist. Diff old‑vs‑incoming graph per node; finalize the pair on a `generated→approved` body change (or brief change → `briefSource='human'`). |
| **Edit magnitude / editKind** | computed at finalize | Normalized token Levenshtein over **style segments only**: `kept` / `light` / `heavy`. Heavy‑edit‑then‑approve = strong directional preference. |
| **Re‑edit churn** | `ContentCanvas.tsx` `updateCn` (editing an approved node auto‑downgrades `approved→generated`) | Increment a `reEditCount` counter on the node — a dense **negative**. Not a duplicate positive event. |
| **Time‑to‑approve + rubber‑stamp flag** | `ContentCanvas.tsx` `approveNode` | ms from generate‑response to approve; near‑zero‑dwell zero‑edit approvals flagged `dwellRubberStamp`. |
| **Salted `editorHash`** | `approveNode` | Never raw identity. For single‑editor overfit resistance. |
| **`directiveVersion` + `injectionCohort`** | stamped at generate time | `'injected' | 'holdout'` for off‑policy credit assignment and causal‑lift measurement. |
| **Downstream proven performance** (sparse, strong) | `scheduler.ts` → `harvest.ts` → `recordExemplar.ts` | A `{planId,nodeId}` `correlationId` joins the harvested X performance back to the originating edit. |
| **EXCLUDED** | — | Email nodes with a `layout` (Final‑copy read‑only) captured but tagged `editKind='email-layout'` and excluded from text learning; any delta classified factual/typo/compliance is dropped. |

---

## 4. Reward function

"Did the change make them happy" = an explicit, tiered, causal‑lift‑corrected scalar **R** per
finalized edit event, computed **offline** so capture never blocks the operator's save.

```
R = wA·approved
  + wE·(1 − editDistanceStyle)      // small distance = the draft was already on-brand
  + wRd·(1 − reEditChurn)           // dense negative when they keep re-touching it
  + wP·performancePercentile        // tenant-relative X likes, ground truth (D2 gate signal)
```

Weights are env‑tunable in `copyStyleLoop.ts` (no hardcoded models), R clamped `[0,1]`, and R is the
per‑event synthesis weight (the `brandRating` analogue in the image loop).

**Tiers**

- **R1 immediate accept** (dense, every approved node, every channel) — `approved=1` is the primary
  signal because it exists everywhere.
- **R2 edit‑magnitude shaping** — heavy‑edit‑then‑approve learns the *direction*; accepted‑as‑is is
  low‑weight confirmation of the *current* policy.
- **R2b re‑edit churn** — dense negative.
- **R3 downstream proven performance** (sparse, strong, **the D2 injection gate**) — tenant‑relative
  percentile of the tenant's *own* harvested likes (NOT the flat‑25 bar, which starves low‑traffic
  tenants), joined via `correlationId`. When it lands (48 h–7 d later) a reconciliation cron
  re‑weights the event to `rewardTier='proven'`.

**Happiness inference, de‑contaminated (the #1 guard):**

- Edit‑distance / acceptance are **never** credited in absolute terms — only as `injected − holdout`
  delta (D1).
- Every event is tagged with the `directiveVersion` that conditioned its draft; a directive's own
  `kept`/low‑edit outputs are **excluded from that same version's reward** (off‑policy correction),
  so a mediocre directive can't earn reward just by making drafts look familiar.
- Rubber‑stamp discount: near‑zero‑dwell zero‑edit approvals shrink toward the prior.
- Single‑editor concentration down‑weights reward.
- `wP` is weighted high enough that published bland‑but‑unengaging copy earns **net‑negative** reward
  and retires the fragments that produced it (blandness / mode‑collapse counter).

**Isolating style from fact/typo/legal (hard gate, belt‑and‑suspenders):**

1. A regex/entity **pre‑filter** over numbers, prices, dates, URLs, emails, proper nouns runs first.
2. On top, an LLM classifier (`content.copy_edit_classify`) labels `editType ∈ {tone, phrasing,
   structure, length, cta, formatting | factual, typo, compliance, mixed}`.
3. Only `tone/phrasing/structure/length/cta/formatting` feed the reward‑weighted style corpus;
   `factual/typo/compliance` are **dropped** before synthesis. For `mixed`, only the style component
   is extracted.
4. Hard never‑learn list for legal/claims/disclaimers. The directive may describe **abstract style
   moves only** — never a verbatim substituted value, and **never** an instruction to *remove* a
   required element (disclaimer / unsubscribe / claim). Additive‑only, into a fenced channel.

---

## 5. Data model (two planes)

Mirrors the existing split: `performance_exemplars` (regional) vs `learnedImageStyle` (control‑plane).

### 5A. Raw events — `copy_edit_events` (regional DB)

New top‑level collection in the **regional** DB via `getDb(databaseIdForRegion(ctx.region))`, cloned
verbatim from `src/lib/tenant/exemplars.ts:16‑53` (ref helper + `tenantId` pre‑filter + restamp‑from‑ctx
on write + per‑row `tenantId` re‑check on read). New type file `src/lib/types/copyEditEvent.ts`.

```ts
// src/lib/types/copyEditEvent.ts  (all fields capped like performanceExemplar.ts;
// the Firestore VectorValue embedding is written via FieldValue.vector and kept OUTSIDE the schema)
CopyEditEventSchema = {
  id, tenantId, planId, nodeId,
  channel(<=40), nodeRole(<=40),
  draftNonce(<=64),
  directiveVersion(int | null),
  injectionCohort: 'injected' | 'holdout',
  editKind: 'text' | 'email-layout',
  briefSource: 'machine' | 'human',
  aiDraft(<=4000, scrubbed),   humanFinal(<=4000 | null, scrubbed),
  autoBrief(<=2000 | null),    editedBrief(<=2000 | null),
  classification: CopyStyleProfile | null,
  editType(enum, default 'phrasing'),
  dNormStyle(0..1), editMagnitude(0..1),
  approved(bool), reEditCount(int>=0),
  timeToApproveMs(int>=0), dwellRubberStamp(bool),
  editorHash(<=64, salted),
  correlationId('planId:nodeId'),
  rewardTier: 'draft' | 'accepted' | 'proven',
  reward(float | null), rewardComponents(record),
  createdAt, approvedAt(| null),
}

CopyStyleProfileSchema = {  // every field .max().default so a sparse extraction still parses
  lexiconAdded[<=12 x <=40], lexiconRemoved[<=12 x <=40],
  sentenceLenShift: 'shorter'|'longer'|'same' (default 'same'),
  toneShift(<=120), structuralMoves[<=8 x <=120], forbiddenPhrasings[<=8 x <=80],
  classification: 'style'|'fact'|'typo'|'compliance'|'mixed' (default 'style'),
}
```

- **Doc id** = `cee:{encodeURIComponent(tenantId)}:{planId}:{nodeId}:{draftNonce}` — `encodeURIComponent`
  stops a colon in a tenantId from bridging tenants; the `draftNonce` makes re‑approve of the **same**
  draft overwrite one event (no reward inflation from approve↔un‑approve churn), while a genuine
  regeneration mints a **new** event (history preserved).
- PII‑scrub (`scrubExemplarText`) before store/embed. Embedding = `FieldValue.vector(embedDocument(humanFinal, ctx.region))`, 768‑dim `text-embedding-005`, region‑pinned. (Embedding only needed once phase 6 pair retrieval ships.)
- **Retention:** rolling window (e.g. last ~400 finalized pairs / tenant or 180 d TTL); `proven`‑tier events exempt from age pruning.

### 5B. Learned directive — `tenant.learnedCopyStyle` (control‑plane)

New **top‑level** field on the `tenants` doc (default DB, cross‑region readable, grounds all copy) —
NOT nested in `brandKit`, NOT a field on `brandVoice`. Top‑level makes it clobber‑safe against both
`setTenantBrandVoice`'s whole‑object write and whole‑`brandKit` replaces with **zero** carry‑forward
helper — strictly cleaner than `learnedImageStyle`, and it exactly follows the `setTenantBrandVoice`
precedent (`control.ts:118‑127`).

```ts
// src/lib/types/tenant.ts — add near tenant.brandVoice (:365)
LearnedCopyStyleSchema = {
  version(int),
  directive(string.max(2000) | null),
  rules[<=MAX_RULES]{ text(<=200), editType, support(int) },
  channelFragments(record<channel, string.max(800)>),
  updatedAt(<=40 | null), sampleCount(int>=0 | null),
  championScore(number | null),
}
tenant.learnedCopyStyle?: LearnedCopyStyle
```

- Persisted via a new dotted writer `setTenantLearnedCopyStyle` (clone of `setTenantLearnedImageStyle`,
  `control.ts:79‑93`, but writing the **top‑level** key like `setTenantBrandVoice`).
- **Residency guarantee:** directive/rules/fragments are **abstract style descriptors**; the synthesis
  prompt is instructed and post‑filtered to strip any verbatim customer substring, entity, or proper
  noun before persist — so no EU‑derived verbatim copy crosses to the (likely US) control plane.
- **Provenance:** `contentPlan.ts` adds `ContentNode.briefSource ('machine'|'human', default 'machine')`
  and a `draftNonce`.

---

## 6. Learn step

New `src/lib/content/create/copyStyleProfile.ts`, mirroring `styleProfile.ts:101‑168`.

> **Not fire‑and‑forget:** App Hosting / Cloud Run throttles CPU once the HTTP response is sent, so a
> detached job would silently never finish. Run the trigger **awaited‑but‑fail‑soft** — each internal
> step `try/catch`‑swallows so awaiting can never fail the already‑persisted save — or move it to the
> existing cron. A **nightly re‑weight** is required regardless because R3 rewards land days later.

Pipeline (gated by `COPY_STYLE_LEARN_ENABLED`):

1. **`extractCopyStyleProfile`** — `renderPrompt('content.copy_style_extract', {aiDraft, humanFinal,
   autoBrief, editedBrief, channel})` → `generateText` → `parseFirstJson` → `CopyStyleProfileSchema.safeParse`
   → null on any failure. The prompt drops fact/typo/compliance deltas (backed by the regex pre‑filter).
2. **Reward computation** (§4) with holdout de‑contamination, off‑policy version exclusion,
   rubber‑stamp discount, single‑editor down‑weight.
3. **`refreshLearnedCopyStyle`** — pull capped, reward‑weighted, recency‑decayed **style** events
   (`MAX_EVENTS_FOR_SYNTHESIS ~20`, `MAX_NEGATIVES ~8`, per‑editor cap), build an APPROVED block + an
   AVOID block, synthesize ONE directive **plus per‑channel fragments and support‑counted rules** via
   `content.copy_style_synthesize`. Each rule needs `MIN_SUPPORT >= 3` independent **nodes/sessions**
   (counts nodes, not human identities — resolves the single‑operator‑tenant deadlock).
   `deterministicDirective` fallback keeps the **prior** directive on model‑unavailable (never
   invent/wipe); empty‑guard clears only when the positive pool is truly empty; `.slice(0, 2000)`.
4. **Champion/challenger gate** — an LLM judge (`content.copy_brand_fit_judge`) scores a held‑out
   slice of recent **chosen** copies under old‑vs‑new. **Auto‑promote (D3)** the new version (bump
   `version`, strip verbatim substrings, persist via `setTenantLearnedCopyStyle`) **only if** brand‑fit
   does not regress. Hysteresis/debounce so it can't rewrite on every approve.

No hardcoded models (`modelConfig.ts`, env‑overridable).

---

## 7. Injection

The **copy** path grounds through `brandVoiceSection ← resolveBrandVoiceText / activeBrandVoiceText`
(NOT `assembleBrandContext`, which is the image/layout path — this is the corrected hook).

- **Primary hook:** extend `resolveBrandVoiceText` (`brandContext.ts:36‑43`) with a
  `learnedCopyStyle?: string | null` param and `activeBrandVoiceText` (`activeBrandVoice.ts`) to load
  `tenant.learnedCopyStyle` and pass the **channel‑scoped fragment** (never a social‑derived move into
  email/long‑form). Append **tri‑state** (`undefined`=auto‑use / `null`=suppress = per‑generation
  "use learned copy style: off" / string=verbatim override), mirroring the `learnedImageStyle` logic
  at `brandContext.ts:83‑89`.
  - ⚠️ `activeBrandVoiceText` currently takes `(tenantId, workspaceBrandVoice)` — **add a `channel`
    param** and thread `node.channel` from `generate/route.ts` + `brief/route.ts`.
- Because both routes already resolve voice via `activeBrandVoiceText`, this **one change** flows the
  directive into `generateNode`'s `composePrompt` identity slot, `nodeBrief.generateNodeBrief`, Agent 3,
  and Live with **zero per‑call wiring**. Combined string is fenced **UNTRUSTED** downstream by
  `brandVoiceSection` (`compose.ts`) — correct, since it is machine‑synthesized from
  attacker‑influenceable human edits. Cap ≤2000. **Byte‑identical output until a directive exists**
  (null → today's exact string).
- **D2 injection gate:** the directive grounds a generation only when
  `injectionEligible(tenant, channel)` — i.e. that tenant × channel has `>= MIN_PROVEN` `rewardTier='proven'`
  events. Below the threshold → stays learn‑dark (byte‑identical).
- **D1 holdout:** a permanent randomized 10–20 % of eligible generations run with the directive OFF
  (`injectionCohort='holdout'`), stamped at generate time; lift is read only as `injected − holdout`.
- **Secondary (phase 6) before→after preference pairs** in the **trusted exemplars slot**: new
  `retrieveCopyExemplars.ts` mirrors `retrieveExemplars.ts` (`embedQuery(node.brief||spark||role,
  region)`, `copyEditEventsRef.where('channel','==',channel).findNearest` COSINE with `tenantId` a
  **mandatory** prefilter + per‑row `tenantId`+`channel` re‑check that **fail‑CLOSES**, returning ≤3
  positive‑reward pairs) spliced alongside the existing performance exemplars in `generateNode`. Even
  in the trusted slot they get the never‑follow / never‑copy‑verbatim DATA fence.
- **Best‑of‑N (phase 7, `COPY_BEST_OF_N_ENABLED`, small N):** `generateNode` samples N candidates,
  scores each with `content.copy_brand_fit_judge` (rubric = reward function), returns argmax —
  inference‑time policy optimization with frozen weights, mirroring image L3 (`creative.ts`).

---

## 8. Guardrails checklist (must‑haves)

- [ ] **Self‑consumption:** permanent injection‑OFF holdout (D1); `injected − holdout` only; per‑version off‑policy reward exclusion; downstream proven performance weighted above the proxy.
- [ ] **Blandness / mode‑collapse:** `wP` high enough that underperforming published copy is net‑negative + retires its fragments; distinctiveness audit (self‑BLEU / distinct‑n) as an active decay/kill‑switch; authored `brandVoice` stays PRIMARY.
- [ ] **Cross‑channel homogenization:** per‑channel fragments; inject only the matching channel's fragment; email excluded; MMR diversity in pair selection.
- [ ] **Fact/typo/legal:** regex/entity pre‑filter + LLM classifier; factual/typo/compliance dropped; never‑learn list; abstract moves only; never remove a required element.
- [ ] **Cold‑start poisoning:** `MIN_SAMPLES` (≥3–5 style events) before any directive is synthesized/injected; `MIN_SUPPORT` (≥3 nodes/sessions) per rule; phase 1 capture‑only.
- [ ] **Single‑editor idiolect:** salted `editorHash` + per‑editor cap + reward down‑weight; `MIN_SUPPORT` counts nodes not identities (lone‑operator tenants aren't deadlocked); "learned from one person" warning.
- [ ] **Tenant isolation fail‑CLOSED:** `tenantId` a mandatory `findNearest` prefilter AND a per‑row re‑check that drops mismatches; server‑restamped `tenantId`; `encodeURIComponent` doc ids.
- [ ] **Region correctness:** abstract directive with ZERO verbatim customer substrings (strip/scrub before persist); region‑pinned embeddings; scrub synthesis INPUTS.
- [ ] **Prompt injection:** fence all captured copy as UNTRUSTED at generation, retrieval, classify AND synthesis; before/after pairs get the never‑follow wrapper even in the trusted slot.
- [ ] **Non‑stationarity / oscillation:** champion/challenger gate + directive versioning + hysteresis; sliding‑window value estimate + per‑update magnitude clamp; empty‑guard so a transient empty top‑N never wipes a good directive.
- [ ] **Event idempotency:** key on `(node + draftNonce)`; churn as a counter not duplicate positives; dedupe downstream promotion on the same key.
- [ ] **Rubber‑stamp / automation bias:** near‑zero‑dwell approvals shrunk to the prior; prefer holdout + downstream over raw approval counts.
- [ ] **Stale / sparse reward:** tenant‑relative percentile downstream; directive kept strictly secondary/capped/fenced.
- [ ] **Metric‑blindness:** never swallow synthesis errors silently — count them; dead‑letter failed captures; instrument capture‑success vs approve volume, synthesis success/error, reward distribution, directive‑version diffs; operator "review/veto learned style" affordance.
- [ ] **Server‑authoritative baseline:** write pristine `aiDraft` server‑side at generate time; client refs optimization only.
- [ ] **Fail‑soft + flags:** independent kill‑switches `COPY_STYLE_CAPTURE / LEARN / INJECT / BEST_OF_N`; every capture/extract/synthesis step `try/catch`‑swallows; no hardcoded model names.
- [ ] **Poisoning caps:** `MAX_EVENTS_FOR_SYNTHESIS ~20`, `MAX_NEGATIVES ~8`, ≤3 injected pairs, `MAX_CONTEXT_CHARS ~6000`, directive `.slice(0,2000)`, per‑field ≤4000; raw human deltas live ONLY in `copy_edit_events`, promoted into `performance_exemplars` only after publish + crossing the bar.

---

## 9. Phased roadmap (reordered for D2)

Every phase honours the build → adversarial review → fix → green gates+smoke → merge → deploy discipline.

| Phase | Goal | Behaviour change | Flags |
|-------|------|:---:|-------|
| **1. Capture only** | Land clean, region‑correct, PII‑scrubbed, idempotent copy + brief events with a server‑authoritative AI‑draft baseline. Validate data quality. | **No** | `COPY_STYLE_CAPTURE_ENABLED` (dev) |
| **2. Reward + classifier (offline)** | Compute R1/R2/R2b + `editType`; prove style‑vs‑fact/typo/compliance separation on real data. | **No** | capture on; reward computed, no injection |
| **3. Downstream reward bridge (D2 prerequisite)** | `correlationId` join Create→harvest→recordExemplar; reconciliation cron upgrades `rewardTier→proven` (tenant‑relative percentile); decay/retirement + homogenization audit. | **No** | `COPY_STYLE_REWARD_BRIDGE_ENABLED` (dev) |
| **4. Synthesize + persist (dark)** | Versioned, support‑gated directive + per‑channel fragments + champion/challenger gate. Directive stored, injects nothing. | **No** | `COPY_STYLE_LEARN_ENABLED` (dev) |
| **5. Inject directive (first behaviour change)** | Ground copy on the channel‑scoped directive, **gated on proven performance (D2)**, holdout (D1), auto‑promote (D3), per‑generation off + operator veto. | **Yes** | `COPY_STYLE_INJECT_ENABLED` (dev first, `MIN_PROVEN`‑gated per tenant/channel) |
| **6. Preference pairs** | `retrieveCopyExemplars` before→after pairs into the trusted exemplar slot; deploy `copy_edit_events` vector index. | **Yes** | `COPY_STYLE_PAIRS_ENABLED` (dev) |
| **7. Best‑of‑N + prod** | Inference‑time rejection sampling under the rubric‑as‑reward‑model; then prod rollout behind the holdout. | **Yes** | `COPY_BEST_OF_N_ENABLED` (last, small N) |

> **Reorder note vs original design:** D2 pulls the downstream reward bridge **before** injection
> (phase 3 here, was phase 5). Synthesis (phase 4) can still run on approval/edit‑magnitude data while
> injection (phase 5) waits for `proven`‑tier events per tenant × channel.

### Phase‑by‑phase file changes

**Phase 1 — Capture only**
- ➕ `src/lib/types/copyEditEvent.ts` — `CopyEditEventSchema` + `CopyStyleProfileSchema` (embedding outside schema).
- ➕ `src/lib/tenant/copyEditEvents.ts` — `copyEditEventsRef` + `writeCopyEditEvent` + `finalizeCopyEditEvent` (clone of `exemplars.ts:16‑53`); export via `src/lib/tenant/index.ts`.
- ✏️ `src/lib/types/contentPlan.ts` — add `ContentNode.briefSource` + `draftNonce`.
- ➕ `src/lib/content/create/captureCopyEdit.ts` — baseline write + PUT‑diff finalize; fail‑soft; idempotent on `(node+draftNonce)`.
- ✏️ `…/nodes/[nodeId]/generate/route.ts` — server‑authoritative `aiDraft` baseline + `draftNonce` + `directiveVersion` + `injectionCohort` at the `patch.body` persist.
- ✏️ `…/nodes/[nodeId]/brief/route.ts` — `autoBrief` baseline + `briefSource='machine'`.
- ✏️ `content-plans/[planId]/route.ts` — PUT diff seam: finalize copy/brief pairs (fire‑and‑forget) + trigger `refreshLearnedCopyStyle` (dark until phase 4).
- ✏️ `src/components/admin/workspace/create/ContentCanvas.tsx` — `reEditCount` in `updateCn`; `timeToApproveMs` + salted `editorHash` + `injectionCohort` at `approveNode`; client‑ref snapshots as optimization.
- ✏️ `firestore.indexes.json` — `copy_edit_events` `[tenantId, channel, createdAt DESC]` + `[tenantId, rewardTier, createdAt DESC]` (all regional DBs). Exclude email nodes (`editKind='email-layout'`).
- ➕ `src/lib/content/create/copyStyleLoop.ts` — flags + caps + reward weights (clone of `brandStyleLoop.ts`, no hardcoded models).

**Phase 2 — Reward + classifier**
- ✏️ `src/lib/agents/prompts/registry.ts` — add `content.copy_edit_classify` + the regex/entity pre‑filter.
- ✏️ `captureCopyEdit.ts` / `copyStyleProfile.ts` — compute `dNormStyle`, `editType`, `editMagnitude`, `reward` + `rewardComponents` (rubber‑stamp discount, single‑editor down‑weight); store on events.
- ➕ reward‑distribution + rubber‑stamp/single‑editor counters (metrics).

**Phase 3 — Downstream reward bridge**
- ✏️ `src/lib/types/performanceExemplar.ts` + `src/lib/distribute/feedback/recordExemplar.ts` + `src/lib/distribute/scheduler.ts` — add `correlationId` + `source:'human-edited'` for the downstream‑reward join.
- ➕ reconciliation cron: on X‑like crossing, upgrade `rewardTier→proven` (tenant‑relative percentile), re‑weight synthesis; run decay/retirement + homogenization audit.

**Phase 4 — Synthesize + persist (dark)**
- ✏️ `src/lib/types/tenant.ts` — `LearnedCopyStyleSchema` + top‑level `tenant.learnedCopyStyle`.
- ✏️ `src/lib/tenant/control.ts` — `setTenantLearnedCopyStyle` (top‑level dotted writer; clone `:79‑93`, no carry‑forward).
- ➕ `src/lib/content/create/copyStyleProfile.ts` — `extractCopyStyleProfile` + `refreshLearnedCopyStyle` + champion/challenger gate + `deterministicDirective` + persist (clone `styleProfile.ts:34‑168`).
- ✏️ `registry.ts` — `content.copy_style_extract` + `content.copy_style_synthesize` + `content.copy_brand_fit_judge`.
- `MIN_SAMPLES` + `MIN_SUPPORT` gates, deterministic fallback, empty‑guard, verbatim‑substring strip; debounce/cron trigger, awaited‑but‑fail‑soft; synthesis success/error counters + version‑diff log.

**Phase 5 — Inject directive**
- ✏️ `src/lib/content/create/brandContext.ts` — `resolveBrandVoiceText` gains `learnedCopyStyle?: string|null`, appends the channel‑scoped fragment tri‑state.
- ✏️ `src/lib/content/create/activeBrandVoice.ts` — load `tenant.learnedCopyStyle`, add a `channel` param, pass the channel‑scoped fragment (single hook → `generateNode`/`nodeBrief`/Agent 3/Live).
- ✏️ `generate/route.ts` + `brief/route.ts` — pass `node.channel`; `injectionEligible(tenant, channel)` (D2) + holdout stamping (D1).
- ✏️ `src/components/admin/workspace/create/ContentNodeInspector.tsx` — per‑generation "use learned copy style: off" tri‑state + "review/veto learned style" affordance.
- Adversarial multi‑agent review of the prompt‑injection surface.

**Phase 6 — Preference pairs**
- ➕ `src/lib/content/create/retrieveCopyExemplars.ts` — mirror `retrieveExemplars`, fail‑closed tenant prefilter, caps, DATA fence.
- ✏️ `generateNode.ts` — splice retrieved pairs into the exemplars slot; record `directiveVersion`.
- ✏️ `firestore.indexes.json` — `copy_edit_events` `[tenantId, channel, embedding dim768 flat]` vector index (all regions).

**Phase 7 — Best‑of‑N + prod**
- ✏️ `generateNode.ts` — sample N, score via `content.copy_brand_fit_judge`, return argmax.
- Provision distillation cron in prod; deploy all `copy_edit_events` indexes US/EU/Asia; green gates + smoke + adversarial review; roll flags capture→learn→bridge→inject→pairs→best‑of‑N per environment behind the holdout.

---

## 10. Complete file map

**New**
- `src/lib/types/copyEditEvent.ts`
- `src/lib/tenant/copyEditEvents.ts`
- `src/lib/content/create/captureCopyEdit.ts`
- `src/lib/content/create/copyStyleLoop.ts`
- `src/lib/content/create/copyStyleProfile.ts`
- `src/lib/content/create/retrieveCopyExemplars.ts` (phase 6)

**Edited**
- `src/lib/types/tenant.ts` · `src/lib/types/contentPlan.ts` · `src/lib/types/performanceExemplar.ts`
- `src/lib/tenant/index.ts` · `src/lib/tenant/control.ts`
- `src/lib/content/create/brandContext.ts` · `activeBrandVoice.ts` · `generateNode.ts` · `nodeBrief.ts`
- `src/lib/agents/prompts/registry.ts`
- `src/lib/distribute/feedback/recordExemplar.ts` · `src/lib/distribute/scheduler.ts`
- `…/content-plans/[planId]/route.ts` · `…/nodes/[nodeId]/generate/route.ts` · `…/nodes/[nodeId]/brief/route.ts`
- `src/components/admin/workspace/create/ContentCanvas.tsx` · `ContentNodeInspector.tsx`
- `firestore.indexes.json`

---

## 11. Flags & config (`copyStyleLoop.ts`)

- `COPY_STYLE_CAPTURE_ENABLED` · `COPY_STYLE_REWARD_BRIDGE_ENABLED` · `COPY_STYLE_LEARN_ENABLED` · `COPY_STYLE_INJECT_ENABLED` · `COPY_STYLE_PAIRS_ENABLED` · `COPY_BEST_OF_N_ENABLED`
- Numeric caps: `MAX_EVENTS_FOR_SYNTHESIS`, `MAX_NEGATIVES`, `MAX_INJECTED_PAIRS`, `MAX_CONTEXT_CHARS`, `MIN_SAMPLES`, `MIN_SUPPORT`, `MIN_PROVEN`, `HOLDOUT_PCT`.
- Reward weights: `wA`, `wE`, `wRd`, `wP` (env‑tunable).
- No hardcoded model names — resolve via `modelConfig.ts`.

---

## 12. Firestore indexes

- `copy_edit_events` `[tenantId ASC, channel ASC, createdAt DESC]` — weighted/recency synthesis.
- `copy_edit_events` `[tenantId ASC, rewardTier ASC, createdAt DESC]` — tiered reads (proven‑gate).
- `copy_edit_events` `[tenantId ASC, channel ASC, embedding dim768 flat]` — phase 6 pair retrieval.
- Deploy to **all** regional DBs (US/EU/Asia); duplicate the `performance_exemplars` block. `firestore.rules` unchanged (deny‑all; server bypasses via IAM).

---

## 13. Metrics / observability

Capture‑success vs approve volume · synthesis success/error counters · reward distribution · directive‑version diffs · injected‑vs‑holdout lift · rubber‑stamp & single‑editor flags · dead‑letter for failed captures · operator "review/veto learned style" surface.

---

## 14. Open items

Resolved by founder: **D1 holdout = yes**, **D2 inject only on proven performance**, **D3 auto‑promote past the gate**.

Still to confirm before/while building:

1. **Email coverage.** Layout‑shaped email nodes (read‑only Final‑copy, structured HTML diffs) are excluded from the text loop v1. Email is a major channel for several tenants — acceptable to defer to a later structured‑layout‑delta learner, or is email‑copy learning a v1 requirement?
2. **Explicit per‑tenant never‑learn list.** On top of the automatic fact/typo/compliance classifier, do you want a founder/legal‑maintained never‑learn list (disclaimers, claims, regulated phrasing)?
3. **Regional directive residency.** The abstract directive lives on the control‑plane tenant doc (likely US) and grounds copy everywhere; we guarantee zero verbatim customer substrings. Is an abstract, non‑PII synthesized directive on the control plane acceptable, or must the directive be pinned per‑region alongside its source events?
4. **Editor privacy.** Salted `editorHash` (never raw identity) + a "being learned from one person" warning. Acceptable under privacy commitments? Who sees the "review/veto learned style" affordance — every workspace admin, or founder/owner only?
5. **`MIN_PROVEN` threshold + holdout %.** Concrete values for the D2 proven‑event gate and the D1 holdout percentage (default proposal: `MIN_PROVEN=5`, `HOLDOUT_PCT=15`).

---

## 15. Provenance

Design produced 2026‑07‑23/24 by a multi‑agent workflow (5 subsystem readers → 3 competing designs
[CopyStyle / CopyDPO / CopyRL] → 3‑judge panel + RL‑failure adversary → synthesis). Winning spine =
CopyStyle (symmetric mirror of the prod image loop); grafted the DPO preference‑pair framing +
versioned rubric + champion/challenger gate, and CopyRL's reward refinements (tenant‑relative
percentile, off‑policy tagging, rubber‑stamp discount). The holdout + off‑policy correction +
style/correction separation are adversary‑driven and non‑negotiable.
