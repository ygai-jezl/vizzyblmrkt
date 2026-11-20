# CLA signatures

Each file here is one person's signature of the
[Individual Contributor Licence Agreement](../individual.md). Read it first.

## Sign in your first pull request

Add one file, in the same pull request as your first contribution:

- **Name:** your GitHub login in lowercase, then `.json`. For the login `Some-Login`, the
  file is `docs/cla/signatures/some-login.json`.
- **Contents:** exactly these three keys, and nothing else:

```json
{ "login": "<login>", "cla": "individual-v1", "signedAt": "YYYY-MM-DD" }
```

- `login` is your GitHub login, the same as the file name (letter case doesn't matter).
- `cla` is the agreement you sign. `individual-v1` is the current one.
- `signedAt` is the date you sign, as year, month and day.

Never add your name, email or anything else: the check refuses a file with any other key.

## Rules

- One file per person, added by that person in their own pull request. The CLA check
  fails a pull request that adds someone else's file, or changes or removes any file in
  `docs/cla/`.
- Your signature covers every pull request from your GitHub account. If you rename the
  account, sign again under the new login.
- Organisations sign the [Entity Contributor Licence Agreement](../entity.md) by email
  instead. A maintainer records it in [policy.json](../policy.json), which only
  maintainers change.
