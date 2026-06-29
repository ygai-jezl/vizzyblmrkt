# knowledge-scraper (Cloud Run Job)

The off-request worker for the Knowledge Ingestion & Vector Retrieval (RAG)
feature. It is an **isolated Node package** (its own `package.json` / build) —
it does **not** import the main app's `@/lib/*`, because it ships as a container.

## What it does

Triggered per ingestion by `/api/admin/knowledge/ingest` (via `JobsClient.runJob`
with per-execution env overrides), it:

1. Reads the ticket coordinates from env (`TICKET_ID`, `TENANT_ID`, `CAMPAIGN_ID`,
   `REGION`, `INGEST_SOURCE`, `SOURCE_URI`, `INGEST_REF`).
2. **Collects** content:
   - `github`/`gitlab` → `git clone --depth 1` (token-auth for private repos), then
     reads text/code files (skips lockfiles, binaries, `node_modules`, big files).
   - `docs_url`/`website` → SSRF-safe same-origin shallow crawl (manual-redirect
     re-validation), HTML → markdown.
3. **Chunks** semantically (`src/chunk.ts`): markdown splits at `#`/`##`/`###` and
   fenced code (code fences kept atomic); code files split at top-level
   boundaries; ~1200-token cap; ~15% overlap on adjacent text chunks.
4. **Embeds** each chunk with Vertex `text-embedding-005` (`RETRIEVAL_DOCUMENT`,
   768-d) on the **regional** endpoint for the tenant's residency region (no
   `global` endpoint exists for this model).
5. **Writes** chunks to `campaigns/{campaignId}/knowledge_bases/{chunkId}` in the
   tenant's regional Firestore DB, with `embedding: FieldValue.vector(...)`, and
   advances the ticket `running → embedding → done|partial|failed`.

## Keep in sync with the app

The region maps (`src/config.ts`) and the embedding request (`src/embed.ts`)
deliberately duplicate `src/lib/tenant/region.ts` and `src/lib/agents/embeddings.ts`.
The stored chunk shape must match `src/lib/types/knowledgeBase.ts`. If you change
one, change the other.

## Limitations (documented, not silent)

- The web crawler does **not** execute JavaScript. SPA/JS-only sites render little;
  server-rendered docs sites convert well. A headless-rendering backend is a
  follow-up.
- Code chunking splits at top-level/line boundaries, not full language-aware AST
  blocks (a reasonable cross-language approximation).

## Build / test

```bash
npm install
npm run typecheck
npm test          # vitest — chunker unit tests
npm run build
```

## Provisioning + deploy

```bash
PROJECT=vizzybl-marketing-dev bash deploy.sh
```

This creates the Artifact Registry repo (if missing), builds+pushes the image, and
creates/updates the `knowledge-scraper` Cloud Run Job (timeout 900s, 1 vCPU, 2Gi).

IAM (grant separately):
- **Job runtime SA** (`JOB_SA`, else default compute SA): `roles/datastore.user`,
  `roles/aiplatform.user`, and secret access for `git-token-github` / `git-token-gitlab`.
- **App Hosting runtime SA**: `run.jobs.runWithOverrides` on this job (so the app can
  trigger it).

Secrets (optional, for private repos), with the viewer + secretAccessor + service-agent
versionManager triple:
```bash
firebase apphosting:secrets:set git-token-github --project <project>
firebase apphosting:secrets:set git-token-gitlab --project <project>
```

After deploy, set in `apphosting.yaml` / `apphosting.prod.yaml`:
`KNOWLEDGE_JOB_NAME=knowledge-scraper`, `KNOWLEDGE_JOB_LOCATION=<region>`, and flip
`KNOWLEDGE_RAG_ENABLED="true"` **after** the `knowledge_bases` vector index has built.
