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

## Licences and the contributor licence agreement

The app is AGPL-3.0 ([LICENSE](LICENSE)). Enterprise code in `src/ee` is under the
YouGrow Enterprise Licence ([src/ee/LICENSE](src/ee/LICENSE)), and the Node SDK in
`sdk/node` is MIT. [LICENSING.md](LICENSING.md) maps every part, fonts included.

Outside contributions need a contributor licence agreement (CLA). The agreements are
drafts under legal review. Until they are final, and the founder IP assignment they rest
on is signed, pull requests from outside contributors can't be merged. You can still open
one, and sign the CLA in it. If the agreement's text changes before it is final, it gets
a new id (such as `individual-v2`), and anyone who signed the draft signs again.

- **Before your first pull request,** read
  [docs/cla/individual.md](docs/cla/individual.md), then add
  `docs/cla/signatures/<your login>.json` in that pull request: your GitHub login in
  lowercase, with the three keys in
  [docs/cla/signatures/README.md](docs/cla/signatures/README.md).
- **Contributing for an employer?** If your employer has rights in your work, it signs
  [docs/cla/entity.md](docs/cla/entity.md) instead, by email to the contact in it.
- **The CLA check** on your pull request says in its job summary what is missing.
- **Co-authors:** every human co-author needs a CLA too. Write their GitHub noreply
  address (`<id>+<login>@users.noreply.github.com`) in the Co-authored-by line.
- **AI coding tools:** Co-authored-by lines for the tools listed in
  `docs/cla/policy.json` need no signature. You are responsible for that work as if you
  wrote it yourself.
- **Changes in `src/ee`** are under the Enterprise licence.
