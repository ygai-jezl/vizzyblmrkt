---
name: check-my-change
description: Verify a YouGrow change before calling it done or opening a pull request. Runs typecheck, lint, unit tests and the public repo checks (check:instance, check:private-paths), a production build when relevant, the smoke test when sign-up, sign-in or lifecycle code changed, and reports each summary line. Use it at the end of every change.
---

# Check my change

Run these from the repo root, in order. At the first failure, fix it and run that step again.

## Always

```bash
npm run typecheck
npm run lint
npm test
npm run check:instance
npm run check:private-paths
```

- `typecheck`: no errors printed means it passed.
- `lint`: no errors means it passed. "Direct Firestore access is forbidden outside
  src/lib/tenant/**" means code went around `forTenant(ctx)`. Move that access into
  `src/lib/tenant/`; never turn the rule off.
- `test`: Vitest ends with a `Test Files` line and a `Tests` line. For one file:
  `npx vitest run <path>`. A failure in `scripts/config/feature-switches.test.ts` means a switch
  isn't listed right (see the `add-a-switch` skill); in `src/lib/help/help.test.ts`, a help
  page no longer matches the app.
- `check:instance`: fails when a file names one hosted copy of YouGrow (its domains, projects,
  tenants, App Hosting address or Analytics id). Read the value from config instead.
  `scripts/instance-values.allow` needs a reason for every entry; it isn't a way round the check.
- `check:private-paths`: fails on files that belong only in a deployment's private repo, such
  as `.firebaserc` or `ops/`. Take them out of the change. A fork's own `apphosting.<env>.yaml`
  stays out of pull requests to the upstream repo too.

## When relevant

- `npm run build` after changes to routes, pages, layouts, `next.config.ts`,
  `src/middleware.ts` or code that client components import. It catches what unit tests miss.
  Stop `npm run local` first: both use `.next`.
- `npm run smoke` after changes to sign-up, sign-in, sessions, admin access, the waitlist,
  lifecycle journeys, email sending or API v2. It needs Java 21 and builds first when `.next`
  has no build; after code changes delete `.next` (ask first) so it builds fresh. It ends with
  `==== SMOKE PASS ====` or `==== SMOKE FAIL ====`.
- Vizzy changed: `cd agents/root_agent && ../.venv/bin/python -m pytest tests/ -q`
  (setup in `agents/root_agent/AGENTS.md`).
- The scraper changed: `cd workers/knowledge-scraper && npm run typecheck && npm test`.
- The SDK changed: the root `npm test` already runs `sdk/node/test`.

## Before you report

- `git status` and `git diff`: only the files you meant to change. No `.env` files, keys,
  `apphosting.<env>.yaml`, `.firebaserc`, `.local/` or build output.
- No real people's names, emails or phone numbers in tests or fixtures.
- Copy you wrote keeps to house style. This finds em and en dashes in your diff:
  `git diff -U0 | grep -n -e "$(printf '\342\200\224')" -e "$(printf '\342\200\223')"`
- A changed screen or message has its help page updated (the pull request template asks).

## Report

Quote the real summary lines, for example:

- typecheck: passed, no errors
- lint: passed
- test: the `Test Files` and `Tests` lines as printed
- check:instance and check:private-paths: their one-line results
- build and smoke: the result, or why you didn't run them

Say what you didn't run and why. Pull requests go against `dev`.
