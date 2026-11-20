# Enterprise code

`src/ee` holds YouGrow's Enterprise features (none is built yet). Licensed under the YouGrow
Enterprise Licence (see `LICENSE` here), unlike the AGPL app; `LICENSING.md` at the root maps
every part to its licence. The root `AGENTS.md` rules apply, including `forTenant(ctx)` for
all data and a switch for new behaviour.

## Working here

- Only `src/lib/enterprise/registry.ts` imports from this folder. Everything else asks the
  registry whether a feature is licensed. ESLint and `src/lib/enterprise/boundary.test.ts`
  enforce it.
- The app must build without this folder. CI deletes it, then runs typecheck, lint, the unit
  tests and the build (the "Builds without Enterprise code" job in `.github/workflows/ci.yml`).
- Start every new file with `// SPDX-License-Identifier: LicenseRef-YouGrow-Enterprise`.
- Tests sit beside the code (`*.test.ts`). No test outside this folder may read or import
  anything in it.
- The feature ids and their labels are in `src/lib/enterprise/features.ts`.
