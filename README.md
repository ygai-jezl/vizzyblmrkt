# vizzybl-marketing

Multi-tenant sales & marketing SaaS. **MVP = a gamified public Waitlist.** This
repo is at **Phase 0 (foundations)**.

## Stack
Next.js 15 · React 18 · TypeScript · Tailwind · Zod · Vitest · Firebase
(Firestore + App Hosting). Aligned with the sibling app `vizzybl-portal`.

## What's here (Phase 0)
- **Tenant-isolation layer** — `src/lib/tenant`. The #1 security control: every
  Firestore access is forced through `forTenant(ctx)` so it's partitioned by
  `tenantId`. Raw Firestore access is banned everywhere else by an ESLint rule.
- **Schema-aligned types** — `src/lib/types` (Zod): `tenants`, `tenant_users`,
  `campaigns`, `signups`.
- **Scoring** — `src/lib/waitlist/scoring.ts` (integer-safe; uses the
  per-campaign `spotsToMoveUponReferral`).
- **Guardrails** — deny-all `firestore.rules` backstop, composite
  `firestore.indexes.json`, ESLint isolation rules, CI.
- **Hosting config** — `apphosting.yaml` (dev) + `apphosting.prod.yaml`.
- **Docs** — [`docs/`](./docs): architecture assessment, validation findings,
  ADRs, and the cloud [setup checklist](./docs/SETUP.md).

## Develop
```bash
npm install
npm run emulators     # Firestore + Auth emulators (separate shell)
npm run dev           # http://localhost:3002

npm run typecheck
npm run lint
npm test              # includes the cross-tenant isolation tests
```

## The one rule that matters
Never call Firestore directly. Get a tenant context (`resolveTenantFromOrigin`
for public requests, `tenantContextFromClaims` for the admin portal), then:

```ts
import { forTenant } from "@/lib/tenant";

const repo = forTenant(ctx);
const signups = await repo.signups.find({ orderBy: [["createdAt", "desc"]], limit: 50 });
```

`ctx.tenantId` is always derived server-side — never from a request body. See
[docs/ARCHITECTURE-AND-DELIVERY.md](./docs/ARCHITECTURE-AND-DELIVERY.md) §4 and
[docs/DECISIONS.md](./docs/DECISIONS.md).

## Cloud setup
First-time GCP/Firebase provisioning: [docs/SETUP.md](./docs/SETUP.md).
