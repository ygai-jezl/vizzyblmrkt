# YouGrow Individual Contributor Licence Agreement v1

> Draft under legal review, not yet in force. Outside pull requests can't be merged until
> it is final (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

This agreement is between you and YouGrow.AI Limited ("we" or "us"). It covers every
Contribution you submit to the Project from your GitHub account, now and later. Its id is
`individual-v1`.

If your employer, or anyone else, has rights in the work you make, they sign the
[entity agreement](entity.md) instead, and it names your GitHub account.

## 1. Definitions

- **You**: the person who signs this agreement.
- **Contribution**: any work of authorship, including a change to existing work, that you
  submit to us for the Project: a pull request, a commit, a patch, a suggestion in a
  review, or anything else you send for us to include.
- **Project**: the YouGrow software and documentation that we own or manage, in the
  YouGrow repository and anything published from it.
- **Submit**: to send to us or our representatives in any form, for example a pull
  request, a commit or a comment in our repository.

## 2. You keep your copyright

You keep the copyright in your Contributions. This agreement gives us a licence; it
doesn't transfer ownership.

## 3. Copyright licence

You grant YouGrow.AI Limited, and those who receive software from us, a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable copyright licence to reproduce,
adapt, prepare derivative works of, publicly display, publicly perform, sublicense and
distribute your Contributions and any derivative works of them.

We may license your Contributions, alone or as part of the Project, under any licence
terms, open source or proprietary. This includes the GNU AGPL, the YouGrow Enterprise
Licence and commercial licences.

## 4. Patent licence

You grant YouGrow.AI Limited, and those who receive software from us, a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable patent licence to make, have made,
use, offer to sell, sell, import and otherwise transfer your Contributions. It covers
only the patent claims you can license that your Contribution infringes, alone or
combined with the Project as it was when you submitted it.

If anyone brings patent litigation (including a cross-claim or counterclaim) claiming that
your Contribution, or the Project, infringes a patent, every patent licence granted to them
under this agreement for that Contribution ends on the date the litigation is filed.

## 5. What you confirm

- Each Contribution is yours to give: you made it, or you have the right to submit it
  under this agreement.
- If your employer has rights in what you make, your employer agreed to this
  Contribution, or has signed the [entity agreement](entity.md) for your GitHub account.
- If any part of a Contribution is someone else's work, you say so when you submit it,
  with its source and its licence.
- You are responsible for work you make with AI tools, as if you wrote it yourself. You
  confirm you have the right to submit it under this agreement, and that, as far as you
  know, it doesn't copy work you can't license on these terms.

## 6. Provided as is

Unless the law requires otherwise, or you agree to it in writing, you provide your
Contributions as is, without warranties or conditions of any kind, including warranties of
title, non-infringement, merchantability or fitness for a particular purpose. You don't
have to support your Contributions.

## 7. Tell us if anything changes

You will tell us if you learn of anything that makes what you confirmed in section 5
untrue, by email to the contact below.

## 8. Law and contact

- Governing law: [JURISDICTION]
- Contact: [CONTACT]

## How to sign

Add one file to your pull request, named after your GitHub login in lowercase:
`docs/cla/signatures/<your login>.json`. It holds exactly this, with your login and the
date you sign:

```json
{ "login": "<your login>", "cla": "individual-v1", "signedAt": "YYYY-MM-DD" }
```

Adding that file from your own GitHub account signs this agreement for every Contribution
you submit from that account. The CLA check on your pull request says whether anything is
missing. [signatures/README.md](signatures/README.md) has the rules for the file. If you
rename your GitHub account, sign again under the new login.
