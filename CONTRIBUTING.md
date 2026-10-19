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

The full list, with the public repo checks, is in
[.claude/skills/check-my-change/SKILL.md](.claude/skills/check-my-change/SKILL.md), which
coding agents follow too.

## New features sit behind a switch

New features ship turned off. Read the switch like this, so anything other than
the exact string `"true"` means off:

```ts
if (process.env.MY_FEATURE_ENABLED === "true") {
  // the new behaviour
}
```

Add the switch to `apphosting.yaml` with the value `"false"`, in the group it belongs
to (`NEXT_PUBLIC_*` switches need `BUILD` as well as `RUNTIME`), and to `.env.example`,
left empty, so people can find it. `npm test` fails if a switch the code reads is
missing from `apphosting.yaml` or isn't `"false"` there. Each deployment turns
switches on in its own settings, so your pull request only adds the switch, off.

## Changed a screen? Update its help page

If you change a setup step, a screen people follow or a message they see, update
its help page in `src/components/help/pages/`. The checks in
`src/lib/help/help.test.ts` cover the links, sections and quoted messages. The
pull request template (`.github/pull_request_template.md`) reminds you.

## Keep secrets and personal data out

- Never commit secrets. Keep them in Secret Manager and refer to them by name
  only, from a deployment's own `apphosting.<environment>.yaml`. The shared
  `apphosting.yaml` refers to none.
- Don't commit a deployment's values (project ids, domains, buckets, keys) or its
  `apphosting.<environment>.yaml` and `.firebaserc`. `npm run check:instance`
  and `npm run check:private-paths` catch ours. Your fork keeps its own settings
  file ([docs/self-host.md](docs/self-host.md)); leave it out of pull requests.
- Use made-up people in tests and fixtures, with `example.com` or `.test`
  addresses. Never real names, emails or phone numbers.

## Security problems

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree your work is licensed under the licence of the code
you change: AGPL-3.0 for the app, MIT for the SDK in `sdk/node`.
