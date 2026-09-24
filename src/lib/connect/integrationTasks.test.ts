import { describe, it, expect } from "vitest";
import { ProductMapSchema } from "./productMapSchema";
import { buildIntegrationTasks } from "./integrationTasks";
import { buildIntegrationGuide } from "./integrationGuide";
import { SANDBOX_CATALOG } from "./sandbox";

const map = ProductMapSchema.parse({
  onboardingSteps: [
    { id: "create_brand", label: "Create your brand", completion: "A brand settings doc exists", detection: "server_event", evidence: [{ path: "src/app/api/tenants/create/route.ts", line: 40, excerpt: "setDoc(brand)", verified: true }] },
  ],
  facts: [{ id: "visibility", label: "AI visibility", unit: "%", source: "visibility_history", evidence: [{ path: "functions/src/brand/scheduledSnapshot.ts", line: 214, excerpt: "userVisibility", verified: true }] }],
  hooks: [
    { kind: "signup", description: "Firebase Auth `onCreate` initialises `users/{uid}`.", evidence: [{ path: "functions/src/auth/onUserCreated.ts", line: 12, excerpt: "onCreate", verified: true }] },
    { kind: "deletion", description: "`initiateAccountDeletion` schedules deletion 30 days out.", evidence: [{ path: "made/up.ts", excerpt: "nope", verified: false }] },
    { kind: "consent", description: "Unsubscribe via `unsubscribedAll`." },
    { kind: "timezone", description: "Timezone only in `quietHours`." },
    { kind: "exit_rule", description: "Staff have a `staff` custom claim." },
  ],
  warnings: ["Onboarding is computed only in the browser."],
});

describe("integration tasks", () => {
  it("lists the customer's side in priority order, only sign-up required", () => {
    const tasks = buildIntegrationTasks({ map, health: null, contextEnabled: false });
    expect(tasks.map((t) => [t.id, t.severity])).toEqual([
      ["signup", "required"],
      ["steps", "personalisation"],
      ["context", "personalisation"],
      ["deletion", "compliance"],
      ["preferences", "compliance"],
      ["timezone", "recommended"],
      ["exit", "recommended"],
    ]);
    expect(tasks[0]!.ifSkipped).toMatch(/no emails at all/);
  });

  it("puts each finding on its task, citing only verified code", () => {
    const t = Object.fromEntries(buildIntegrationTasks({ map, health: null, contextEnabled: false }).map((x) => [x.id, x]));
    expect(t.signup!.files).toEqual([{ path: "functions/src/auth/onUserCreated.ts", line: 12 }]);
    expect(t.deletion!.fromCode[0]).toContain("initiateAccountDeletion");
    expect(t.deletion!.files).toEqual([]); // unverified evidence isn't cited
    expect(t.preferences!.fromCode).toEqual(["Unsubscribe via `unsubscribedAll`."]);
    expect(t.steps!.files[0]!.path).toBe("src/app/api/tenants/create/route.ts");
    expect(t.context!.files[0]!.path).toBe("functions/src/brand/scheduledSnapshot.ts");
  });

  it("points developers at source files rather than docs or tests", () => {
    const m = ProductMapSchema.parse({
      onboardingSteps: [
        {
          id: "create_brand",
          label: "Create your brand",
          evidence: [
            { path: "docs/plans/onboarding.md", line: 3, excerpt: "create brand step", verified: true },
            { path: "src/__tests__/onboarding/brand.test.tsx", line: 9, excerpt: "create brand", verified: true },
            { path: "src/app/api/tenants/create/route.ts", line: 40, excerpt: "setDoc(brand)", verified: true },
          ],
        },
      ],
      hooks: [{ kind: "signup", description: "x", evidence: [{ path: "docs/auth.md", line: 1, excerpt: "signup flow", verified: true }] }],
    });
    const t = Object.fromEntries(buildIntegrationTasks({ map: m, health: null, contextEnabled: false }).map((x) => [x.id, x]));
    expect(t.steps!.files).toEqual([{ path: "src/app/api/tenants/create/route.ts", line: 40 }]);
    expect(t.signup!.files).toEqual([{ path: "docs/auth.md", line: 1 }]); // nothing better — keep it
  });

  it("marks what's already working", () => {
    const tasks = buildIntegrationTasks({ map, health: { lastEventAt: "2026-09-23T10:00:00Z", lastContextOkAt: "2026-09-23T10:01:00Z" }, contextEnabled: true });
    expect(tasks.filter((t) => t.status === "done").map((t) => t.id)).toEqual(["signup", "context"]);
  });
});

describe("prompt for the customer's coding agent", () => {
  const connection = { keyId: "ygk_public_id", catalog: { ...SANDBOX_CATALOG, onboardingSteps: [], facts: [] }, contextEndpoint: null, webhookEndpoint: null, health: {} };
  const guide = buildIntegrationGuide({ connection, analysis: { map }, origin: "https://yougrow.test", productName: "vizzybl.ai" });
  const p = guide.agentPrompt;

  it("covers every task, where it goes, and how to check it's done", () => {
    expect(p).toMatch(/^# Connect vizzybl\.ai to YouGrow lifecycle email/);
    expect(p).toContain("### 1. [Required] Send sign-ups");
    expect(p).toContain("`functions/src/auth/onUserCreated.ts:12`");
    expect(p).toContain("https://yougrow.test/developers/context-endpoint");
    expect(p).toContain("## Done when");
  });

  it("uses the proposed steps and facts before anything is accepted into the catalog", () => {
    expect(p).toContain("`create_brand` — Create your brand; done when A brand settings doc exists (send it where the server makes this happen)");
    expect(p).toContain("`visibility` — AI visibility (%); from visibility_history");
  });

  it("names env vars and the public key id — never a secret", () => {
    expect(p).toContain("`YOUGROW_KEY_ID` (public, value `ygk_public_id`)");
    expect(p).toContain("`YOUGROW_SECRET`");
    expect(p).not.toMatch(/ygs_[A-Za-z0-9]/);
  });

  it("adds the optional invite-code task only while invites are on", () => {
    expect(buildIntegrationTasks({ map, health: null, contextEnabled: false }).map((t) => t.id)).not.toContain("invite");
    const withInvites = buildIntegrationTasks({ map, health: null, contextEnabled: false, invites: true });
    expect(withInvites.at(-1)).toMatchObject({ id: "invite", severity: "recommended", status: "todo" });
  });
});

