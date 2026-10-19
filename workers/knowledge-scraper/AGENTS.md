# knowledge-scraper

The Cloud Run Job that reads a website, docs site or git repo into a brand's knowledge: collect,
chunk, embed with Vertex `text-embedding-005`, and write vectors to the tenant's regional
Firestore database. `README.md` in this folder has the detail. The root `AGENTS.md` rules apply.

## Rules here

- It is its own package (own `package.json`, `node_modules` and build) and ships as a container.
  Never import the app (`@/lib/*`).
- It is the one place outside `src/lib/tenant` that uses `firebase-admin` directly. It has no
  tenant context, so it stamps `tenantId` on every write itself. Keep it that way.
- Keep it in step with the app, and change both sides together:
  - `src/config.ts` and `src/embed.ts` copy `src/lib/tenant/region.ts` and
    `src/lib/agents/embeddings.ts` in the app.
  - The chunk shape matches `src/lib/types/knowledgeBase.ts`; page records match what
    `listKnowledgePages` reads in `src/lib/tenant/knowledge.ts`.
- Every fetch goes through the SSRF guard in `src/ssrf.ts`. Don't bypass it, and re-check each
  redirect.
- The root `npm run lint` and `npm test` skip this folder. Test it here.

## Commands (run inside this folder)

```bash
npm ci              # its locked dependencies; adding one is ask first
npm run typecheck
npm test            # Vitest: chunker, config, embed, pages and git token tests
npm run build
```

## Deploy: ask first

`PROJECT=<id> bash deploy.sh` builds and pushes an image and creates or updates the job in that
project. Never run it without the user's yes. Set `SCRAPER_USER_AGENT` on every deploy if the
deployment names its own crawler, since each deploy replaces the job's environment. Service
accounts and roles: `infra/knowledge/setup.sh` (also ask first) and `README.md`.
