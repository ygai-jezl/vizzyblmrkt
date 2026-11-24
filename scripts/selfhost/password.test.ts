// The pure parts of addon:password (scripts/selfhost/spec.mjs): what differs in a project's
// Identity Toolkit config, the order the fixes are sent in, and the two alerts. The add-on run
// against a fake cloud is in selfhost.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH as SCREENS_MIN_LENGTH } from "@/lib/auth/messages";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { baseSwitches } from "./envfile.mjs";
import {
  AUTH_LOG_METRICS,
  KEPT_OFF,
  PASSWORD_MIN_LENGTH,
  authAlertPolicies,
  logMetricBody,
  passwordConfigDiff,
  passwordPatchPlan,
  switchesForAddon,
} from "./spec.mjs";

const APP = "https://app.example.com";
const READY = {
  signIn: { email: { enabled: true, passwordRequired: true }, allowDuplicateEmails: false },
  emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
  passwordPolicyConfig: { passwordPolicyEnforcementState: "ENFORCE", passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 } }], forceUpgradeOnSignin: false },
  recaptchaConfig: { emailPasswordEnforcementState: "AUDIT" },
  monitoring: { requestLogging: { enabled: true } },
  notification: { sendEmail: { callbackUri: `${APP}/auth/reset` } },
};
const ids = (config: unknown, url = APP) => passwordConfigDiff(config, url).map((d: { id: string }) => d.id);

describe("passwordConfigDiff", () => {
  it("finds nothing on a ready project", () => {
    expect(passwordConfigDiff(READY, APP)).toEqual([]);
    expect(passwordConfigDiff({ ...READY, recaptchaConfig: { emailPasswordEnforcementState: "ENFORCE" } }, APP)).toEqual([]);
  });

  it("lists everything on a project with Google sign-in only, the provider last", () => {
    expect(ids({ authorizedDomains: ["localhost"] })).toEqual(["password-required", "privacy", "policy", "recaptcha", "logging", "reset-link", "provider"]);
    expect(ids(null)).toContain("provider");
  });

  it("checks the reset link only when the app's address is known, and only as advice", () => {
    expect(ids(READY, "")).toEqual([]);
    const d = passwordConfigDiff({ ...READY, notification: {} }, `${APP}/`);
    expect(d).toEqual([expect.objectContaining({ id: "reset-link", level: "info", body: { notification: { sendEmail: { callbackUri: `${APP}/auth/reset` } } } })]);
  });

  it("flags duplicate accounts, a weaker or stricter policy, character rules and forced upgrades", () => {
    expect(ids({ ...READY, signIn: { ...READY.signIn, allowDuplicateEmails: true } })).toEqual(["duplicates"]);
    const policy = (p: unknown) => passwordConfigDiff({ ...READY, passwordPolicyConfig: p }, APP);
    expect(policy({ passwordPolicyEnforcementState: "OFF" })[0]?.what).toBe("the password policy isn't enforced");
    expect(policy({ passwordPolicyEnforcementState: "ENFORCE", passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 8 } }] })[0]?.what).toBe(
      "the password policy asks for 8 characters, not 12",
    );
    expect(policy({ passwordPolicyEnforcementState: "ENFORCE", passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 16 } }] })).toHaveLength(1);
    expect(
      policy({ passwordPolicyEnforcementState: "ENFORCE", passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12, containsNumericCharacter: true } }] })[0]?.what,
    ).toBe("the password policy asks for kinds of character the sign-in screens don't explain");
    expect(policy({ ...READY.passwordPolicyConfig, forceUpgradeOnSignin: true })[0]?.what).toBe("the password policy forces a new password at sign-in");
  });

  it("sets the policy to the screens' length, keeping a maximum that allows it", () => {
    const fix = (max: number) =>
      passwordConfigDiff({ ...READY, passwordPolicyConfig: { passwordPolicyEnforcementState: "OFF", passwordPolicyVersions: [{ customStrengthOptions: { maxPasswordLength: max } }] } }, APP)[0]
        ?.body;
    expect(fix(64)).toEqual({
      passwordPolicyConfig: {
        passwordPolicyEnforcementState: "ENFORCE",
        passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12, maxPasswordLength: 64 } }],
        forceUpgradeOnSignin: false,
      },
    });
    expect(JSON.stringify(fix(10))).not.toContain("maxPasswordLength");
    // The screens say the same number Identity Platform enforces, inside its 6 to 30.
    expect(PASSWORD_MIN_LENGTH).toBe(SCREENS_MIN_LENGTH);
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(6);
    expect(PASSWORD_MIN_LENGTH).toBeLessThanOrEqual(30);
  });

  it("turns bot protection on in audit mode, never down from enforce", () => {
    expect(passwordConfigDiff({ ...READY, recaptchaConfig: {} }, APP)[0]?.body).toEqual({ recaptchaConfig: { emailPasswordEnforcementState: "AUDIT" } });
    expect(ids({ ...READY, recaptchaConfig: { emailPasswordEnforcementState: "OFF" } })).toEqual(["recaptcha"]);
  });
});

describe("passwordPatchPlan", () => {
  it("sends small batches with explicit masks, every protection before the provider, which goes alone", () => {
    const plan = passwordPatchPlan(passwordConfigDiff({ signIn: { allowDuplicateEmails: true } }, APP));
    expect(plan.map((b: { label: string; mask: string; soft: boolean }) => [b.label, b.mask, b.soft])).toEqual([
      ["account rules", "signIn.allowDuplicateEmails,signIn.email.passwordRequired,emailPrivacyConfig.enableImprovedEmailPrivacy", false],
      ["password policy", "passwordPolicyConfig", false],
      ["reCAPTCHA bot protection", "recaptchaConfig.emailPasswordEnforcementState", false],
      ["request logging", "monitoring.requestLogging.enabled", false],
      ["reset link address", "notification.sendEmail.callbackUri", true],
      ["Email/Password provider", "signIn.email.enabled", false],
    ]);
    expect(plan[0]!.body).toEqual({ signIn: { allowDuplicateEmails: false, email: { passwordRequired: true } }, emailPrivacyConfig: { enableImprovedEmailPrivacy: true } });
    expect(plan.at(-1)!.body).toEqual({ signIn: { email: { enabled: true } } });
    expect(passwordPatchPlan([])).toEqual([]);
  });
});

describe("the sign-in alerts", () => {
  it("count log metrics whose filters, and the conditions on them, name a resource type", () => {
    for (const m of AUTH_LOG_METRICS) {
      expect(m.filter).toMatch(new RegExp(`^resource\\.type="${m.resourceType}" AND `));
      expect(logMetricBody(m)).toMatchObject({ name: m.name, filter: m.filter, metricDescriptor: { metricKind: "DELTA", valueType: "INT64" } });
    }
    expect(AUTH_LOG_METRICS[0]?.filter).toContain("google.cloud.identitytoolkit.v1.AuthenticationService.SignUp");
    expect(AUTH_LOG_METRICS[1]?.filter).toContain('jsonPayload.event="auth_account_removed"');
    const policies = authAlertPolicies(["projects/p/notificationChannels/1"]);
    expect(policies).toHaveLength(2);
    policies.forEach((p: { conditions: { conditionThreshold: Record<string, unknown> }[]; notificationChannels: string[] }, i: number) => {
      const t = p.conditions[0]!.conditionThreshold;
      expect(t.filter).toBe(`metric.type="logging.googleapis.com/user/${AUTH_LOG_METRICS[i]!.name}" AND resource.type="${AUTH_LOG_METRICS[i]!.resourceType}"`);
      // evaluationMissingData is refused with a zero duration.
      expect(t.evaluationMissingData).toBe("EVALUATION_MISSING_DATA_INACTIVE");
      expect(t.duration).toBe("60s");
      expect(p.notificationChannels).toEqual(["projects/p/notificationChannels/1"]);
    });
    expect(authAlertPolicies()[0]!.notificationChannels).toEqual([]);
  });

  it("explain themselves in house style", () => {
    const texts = [
      ...authAlertPolicies().flatMap((p: { displayName: string; documentation: { content: string }; conditions: { displayName: string }[] }) => [
        p.displayName,
        p.documentation.content,
        ...p.conditions.map((c) => c.displayName),
      ]),
      ...AUTH_LOG_METRICS.map((m) => m.description),
      ...passwordConfigDiff({}, APP).flatMap((d: { what: string; fix: string }) => [d.what, d.fix]),
    ];
    for (const t of texts) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });
});

describe("the sign-in switches in a self-hosted copy", () => {
  it("are kept off by npm run selfhost; addon:password turns on only PASSWORD_SIGNIN_ENABLED", () => {
    const base = baseSwitches(readFileSync(new URL("../../apphosting.yaml", import.meta.url), "utf8")).map((s: { name: string }) => s.name);
    for (const name of ["PASSWORD_SIGNIN_ENABLED", "PASSWORD_CLEANUP_DELETE_ENABLED", "SELF_SERVE_SIGNUP_ENABLED", "TRUSTED_CLIENT_IP_ENABLED"]) {
      expect(base, name).toContain(name);
      expect(KEPT_OFF, name).toHaveProperty(name);
      expect(dashesIn((KEPT_OFF as Record<string, { why: string }>)[name]!.why), name).toEqual([]);
    }
    expect(switchesForAddon("password")).toEqual(["PASSWORD_SIGNIN_ENABLED"]);
  });
});

describe("the self-host troubleshooting row for password sign-in", () => {
  const row = readFileSync(new URL("../../docs/self-host.md", import.meta.url), "utf8")
    .split("\n")
    .find((line) => line.startsWith("| The sign-in page has no email and password fields |"));

  it("points to the check that reports the switch: the doctor checks nothing while it is off", () => {
    expect(row).toBeDefined();
    // The text plan prints only a title per add-on; the JSON plan carries its detail, which names
    // PASSWORD_SIGNIN_ENABLED and the email provider (selfhost.test.ts runs the command this row names).
    expect(row).toContain("`npm run selfhost -- --project <id> --json`");
    expect(row).toContain("`addon:password`");
    expect(row).not.toMatch(/`npm run doctor -- --cloud` says which is missing/);
    expect(dashesIn(row!)).toEqual([]);
    expect(aiTellsIn(row!)).toEqual([]);
  });
});
