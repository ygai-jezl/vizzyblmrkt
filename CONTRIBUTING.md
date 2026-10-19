# Contributing to YouGrow

Thanks for helping. This page is the short version.
[AGENTS.md](AGENTS.md) is the full guide, for people and for coding agents.

## Pull requests

- Branch from `dev` and open your pull request against `dev`, not `main`.
- Keep one pull request to one piece of work.
- Before you push, run all three and make sure they pass:

```bash
npm run typecheck
npm run lint
npm test
```

## New features sit behind a switch

New features ship turned off. Read the switch like this, so anything other than
the exact string `"true"` means off:

```ts
if (process.env.MY_FEATURE_ENABLED === "true") {
  // the new behaviour
}
```

Add the switch to `.env.example`, left empty, so people can find it.

## Changed a screen? Update its help page

If you change a setup step, a screen people follow or a message they see, update
its help page in `src/components/help/pages/`. The checks in
`src/lib/help/help.test.ts` cover the links, sections and quoted messages. The
pull request template (`.github/pull_request_template.md`) reminds you.

## Keep secrets and personal data out

- Never commit secrets. Keep them in Secret Manager and refer to them by name
  only, as `apphosting.yaml` does.
- Use made-up people in tests and fixtures, with `example.com` or `.test`
  addresses. Never real names, emails or phone numbers.

## Security problems

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree your work is licensed under the licence of the code
you change: AGPL-3.0 for the app, MIT for the SDK in `sdk/node`.
