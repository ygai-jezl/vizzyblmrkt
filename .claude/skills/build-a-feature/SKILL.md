---
name: build-a-feature
description: Checklist for building a YouGrow feature, API route or screen the way this codebase expects. Its line in the learning registry first, then behind a switch, tenant scoped through forTenant(ctx), admin routes with the origin check and sign-in like existing routes, tests with the fake Firestore, the matching help page, and the product copy rules. Use it before writing new behaviour, and when reviewing a change for what it missed.
---

# Build a feature

Work through the list in order. Keep it to one piece of work: one pull request against `dev`.

## 1. Say how it learns

Before any code, answer one question for each choice the feature makes for a brand (a new AI
purpose, a canvas Vizzy fills, a connector rule, or a rule that picks something): does it learn
from people? Write the answer as its line in `src/lib/loops/registry.ts`, saying what is true
today:

- `own(store, why)`: it already learns from people in its own store (a `LEARNED_STORES` key).
- `gap(why, revisit)`: it should learn and doesn't yet, with a date to look again at most 6
  months ahead.
- `none(why)`: it should never learn. A real reason makes this a good answer.
- `learns(...)` and `fleetOnly(...)` come once the loops stamp and count what YouGrow makes
  (ADR-0017 in `docs/DECISIONS.md`).

The reason is one plain sentence about this choice that a brand owner could read. A new AI
purpose goes in `src/lib/plans/resources.ts` with its label, and a new rule in `RULE_DECISIONS`;
typecheck fails until the line is there. A file that reuses a purpose needs no new line, but it
shows under that purpose in `docs/ONTOLOGY.md` once you run `npm run ontology:doc`.

## 2. Read the neighbours

Find two or three files that already do something similar and copy their shape: the area's
logic in `src/lib/<area>/`, its routes in `src/app/api/admin/<area>/`, its page in
`src/app/admin/<area>/`, and the area's `flags.ts`.

An Enterprise feature goes in `src/ee` and is asked about through `src/lib/enterprise/registry.ts`; core code never imports it.

## 3. A switch, off

Use the `add-a-switch` skill. The feature does nothing until its switch is exactly `"true"`.

## 4. Data only through forTenant(ctx)

```ts
import { forTenant } from "@/lib/tenant";

const repo = forTenant(ctx);
const signups = await repo.signups.find({ orderBy: [["createdAt", "desc"]], limit: 50 });
```

- `ctx` comes from the server: `getAdminContext()` (`@/lib/auth/session`) in admin routes,
  `resolveTenantFromOrigin` for public pages, `tenantContextFromCanvasToken`
  (`src/lib/canvas/auth.ts`) for Vizzy's routes. Never take a tenant id from the body, query or
  a header the browser sets.
- A new collection goes in the repository in `src/lib/tenant/` (the only folder allowed to use
  Firestore directly), with a test that one tenant can't read or change another's rows (see
  `src/lib/tenant/repository.test.ts`).
- A new collection or file store (Cloud Storage, BigQuery, Memory Bank) also needs an entry in
  `src/lib/ontology/registry.ts`: where it lives, whether it holds people, and how it is erased,
  exported, found and counted. Then run `npm run ontology:doc`.
  `src/lib/ontology/coverage.test.ts` fails until the entry is there.
- A query with several filters or a sort may need a composite index. The emulator won't tell
  you. Add it to `firestore.indexes.json` (ask first).

## 5. Admin API routes

Copy `src/app/api/admin/settings/mailchimp/route.ts`, or a gate like
`src/lib/email/emailStyleAdmin.ts`. The order: origin check, switch, sign-in, role, input.

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req); // @/lib/http/sameOrigin
  if (blocked) return blocked;
  if (!isMyFeatureEnabled()) return NextResponse.json({ error: "my_feature_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = Schema.safeParse(await req.json().catch(() => null)); // zod
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // ... forTenant(ctx) ...
}
```

- Members may read where the area allows it; only admins change things.
- Never send a secret back. The Mailchimp route answers `apiKeySet: true`, not the key.
- Public routes (`src/app/api/waitlist/`, `src/app/api/v2/`) resolve the tenant from the
  origin or a verified key, like their neighbours. Scheduled-work routes check the worker
  secret (`src/lib/http/workerSecret.ts`).

## 6. Screens and words

- Admin pages are in `src/app/admin/<area>/`, components in `src/components/admin/`. Hide the
  way in while the switch is off.
- Copy follows `src/lib/content/writingRules.ts`: plain words, no em dashes, en dashes or
  spaced hyphens as punctuation, none of the `AI_TELLS` phrases. Messages say what happened and
  what to do next.
- Changed a setup step, a screen people follow or a message they see? Update its help page in
  `src/components/help/pages/`; a new page also goes in `src/lib/help/pages.ts`.
  `src/lib/help/help.test.ts` checks the links, sections and quoted messages.

## 7. Vizzy

If people would ask the chat to do this, add a tool: a route under `src/app/api/agent/` and a
client in `agents/root_agent/tools/` (see `agents/root_agent/AGENTS.md`). Vizzy only writes
drafts and suggestions that a person accepts.

## 8. Tests

- Vitest, beside the code. Data through `FakeFirestore`
  (`src/lib/tenant/testing/fakeFirestore.ts`); route tests mock `@/lib/auth/session` (model:
  `src/app/api/admin/brand-kit/email-style/route.test.ts`).
- Cover: switch off, signed out (401), member versus admin (403), bad input (400), the happy
  path, and another tenant's data left alone.
- Made-up people only, with `example.com` or `.test` emails.

## 9. Finish

Use the `check-my-change` skill, then fill in `.github/pull_request_template.md`.
