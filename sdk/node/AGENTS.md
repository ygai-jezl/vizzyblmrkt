# Node SDK

`@yougrowai/node`: the client a product's server uses to send its users' state to YouGrow
lifecycle journeys (API v2), and to verify the requests YouGrow sends back. Node 18 or later,
no dependencies, ESM and CommonJS. Licensed MIT (see `LICENSE` here), unlike the AGPL app.
The root `AGENTS.md` rules apply.

## Working here

- Sources are in `src/` (`index.ts` the client, `server.ts` and `jwt.ts` request verification,
  `origin.ts` the default origin), tests in `test/`. The root `npm test`, `npm run typecheck`
  and `npm run lint` cover them.
- `test/vectors.json` ships in the package and is shared with the app: its
  `src/lib/connect/outboundToken.test.ts` signs to it and `/developers/test-vectors.json` serves
  it. Change it only together with the signing and verifying code on both sides.
- Keep it dependency free and server side only: a secret must never reach a browser bundle.
- The HTTP API is the contract. A change here that needs an API change needs the app side too
  (`src/app/api/v2/`), behind a switch.
- Build the package locally with `npm run build` inside this folder (writes `dist/`, git ignored).

## Releases: ask first

- Releases go out only from the upstream repo: a maintainer bumps `version` in `package.json`,
  tags `sdk-node-v<version>` on `main`, and `.github/workflows/sdk-publish.yml` stages it on
  npm, where a maintainer approves it with 2FA.
- Never bump the version, create or push a tag, or run `npm publish` without the user asking.
  A fork can't publish this package name.
