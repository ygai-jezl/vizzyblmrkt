# Enterprise code

This folder holds YouGrow's Enterprise features. None is built yet. The planned features
are listed in `src/lib/enterprise/features.ts`, and the public list of what is open and
what is Enterprise is on the developer docs page `/developers/open-source`.

## Licence

Everything here is under the YouGrow Enterprise Licence ([LICENSE](LICENSE)). It is a draft
under legal review, not yet in force. You may read, change and test this code freely.
Production use needs a subscription and a licence key.

The rest of the app is AGPL-3.0. [LICENSING.md](../../LICENSING.md) maps every part of the
repository to its licence.

## How a feature turns on

A self-hosted copy needs a licence key in the `ENTERPRISE_LICENCE_KEY` setting before any
Enterprise feature turns on. Without one, every feature here stays off and the rest of the
app works as before. `src/lib/enterprise/registry.ts` checks the key and answers whether a
feature is licensed.

## Rules for this folder

- Only `src/lib/enterprise/registry.ts` may import from here. Everything else asks the
  registry. ESLint and `src/lib/enterprise/boundary.test.ts` enforce it.
- The app must build without this folder. Deleting it gives a build with no Enterprise
  code. That build still holds the MIT Node SDK code that `src/lib/developers/flags.ts`
  imports, and fonts under the SIL Open Font Licence. CI checks it on every pull request
  (the "Builds without Enterprise code" job).
- Start every new file with this line:
  `// SPDX-License-Identifier: LicenseRef-YouGrow-Enterprise`
- The root rules apply here too: data only through `forTenant(ctx)` from `@/lib/tenant`,
  and new behaviour behind a switch. [AGENTS.md](AGENTS.md) is the guide for this folder.
