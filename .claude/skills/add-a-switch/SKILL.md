---
name: add-a-switch
description: Add, rename or remove a YouGrow feature switch so new behaviour ships off. Covers the exact "true" read, the apphosting.yaml entry, .env.example, the NEXT_PUBLIC build rule and the test that checks them. Use it whenever a change adds behaviour that should be off by default, or touches an *_ENABLED variable.
---

# Add a feature switch

## 1. Name it

`<AREA>_<FEATURE>_ENABLED` in capitals. Add the `NEXT_PUBLIC_` prefix only when browser code
(a client component) must read it. Server switches are better when you can: a deployment
changes them without a new build.

## 2. Read it in one place

Add a small function to the area's `flags.ts` (for example `src/lib/email/flags.ts`,
`src/lib/lifecycle/flags.ts` or `src/lib/help/flags.ts`):

```ts
/** What it turns on, in one line. Off = the app behaves as before. */
export function isMyFeatureEnabled(): boolean {
  return process.env.MY_FEATURE_ENABLED === "true";
}
```

- Compare with the exact string `"true"`, written out like that. The switch scan in
  `scripts/config/feature-switches.mjs` finds switches by that pattern, so don't use
  `process.env[name]` or `Boolean(...)`.
- A switch that needs another one combines them here (see `isSetupGuideEnabled` in
  `src/lib/help/flags.ts`).
- Check it at the edges: API routes answer with a clear "off" response (for example status 503
  and `{ error: "my_feature_disabled" }`), pages hide the way in. With the switch off, the app
  must behave exactly as before.

## 3. List it, off, in apphosting.yaml

Under `# ===== Feature switches =====`, in the group it belongs to, with a one-line comment:

```yaml
  # What it turns on (needs OTHER_FEATURE_ENABLED).
  - variable: MY_FEATURE_ENABLED
    value: "false"
    availability:
      - RUNTIME
```

A `NEXT_PUBLIC_` switch lists `BUILD` as well as `RUNTIME`: its value is built into the page,
so changing it needs a new build. Never put a secret or a deployment's own value in this file.

## 4. List it in .env.example

Under `# Feature switches.`, in the matching group, with no value: `MY_FEATURE_ENABLED=`.

## 5. Test it both ways

- `npm test` runs `scripts/config/feature-switches.test.ts`. It fails when a switch the code
  reads is missing from `apphosting.yaml`, isn't `"false"` there, lacks `BUILD` (for
  `NEXT_PUBLIC_`), or when `apphosting.yaml` lists a switch nothing reads any more.
- In the feature's own tests, cover on and off: `vi.stubEnv("MY_FEATURE_ENABLED", "true")` in
  `beforeEach` and `vi.unstubAllEnvs()` in `afterEach` (see
  `src/app/api/waitlist/[campaignId]/signup/route.test.ts`). Test that off changes nothing.
- A switch read when a module loads needs `vi.hoisted(() => { process.env.X = "true"; })`
  before the imports (see `src/lib/help/help.test.ts`).

## 6. Locally

`npm run local` turns on every `*_ENABLED` switch listed in `apphosting.yaml`, and adds new
ones to the `.env.local` it wrote when it starts. Restart it after adding a switch. If the
feature can't work on the emulators, add it to `SWITCHES_KEPT_OFF` in
`scripts/lib/local-env.mjs` with the reason.

## 7. Rename or remove

Change the read, the `apphosting.yaml` entry and the `.env.example` line together. Say so in
the pull request: deployments set their own value in `apphosting.<env>.yaml` and need to
rename it there.

## Don't

- Turn a switch on in `apphosting.yaml`. Each deployment turns it on in its own settings file.
- Commit an `apphosting.<env>.yaml` or `.firebaserc`.
