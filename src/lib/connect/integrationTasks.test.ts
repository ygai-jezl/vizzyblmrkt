import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEMAS } from "@/lib/developers/schemas";
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
  it("lists the customer's side in priority order — sign-ups and compliance first — only sign-up required", () => {
    const tasks = buildIntegrationTasks({ map, health: null, contextEnabled: false });
    expect(tasks.map((t) => [t.id, t.severity])).toEqual([
      ["signup", "required"],
      ["deletion", "compliance"],
      ["preferences", "compliance"],
      ["timezone", "recommended"],
      ["exit", "recommended"],
      ["steps", "personalisation"],
      ["context", "personalisation"],
    ]);
    expect(tasks[0]!.ifSkipped).toMatch(/no emails at all/);
  });

  it("says what to send in API v2 terms", () => {
    const t = Object.fromEntries(buildIntegrationTasks({ map, health: null, contextEnabled: false, invites: true }).map((x) => [x.id, x]));
    expect(t.signup!.action).toContain("PATCH the user with `signedUpAt`");
    expect(t.steps!.action).toContain("Include `steps`");
    expect(t.context!.title).toContain("(optional)");
    expect(t.deletion!.action).toContain("`DELETE /api/v2/users/{userId}`");
    expect(t.preferences!.action).toContain("`subscribed: false`");
    expect(t.timezone!.action).toContain("`timezone`");
    expect(t.exit!.action).toContain("`excluded`");
    expect(t.invite!.action).toContain("`traits.yg_invite`");
    const text = Object.values(t).map((x) => `${x.title} ${x.action} ${x.ifSkipped}`).join("\n");
    expect(text).not.toMatch(/identify|user\.signed_up|step_completed|user\.deleted|email_preferences\.updated|messageId|\bevents?\b/);
  });

  it("puts each finding on its task, citing only verified code", () => {
    const t = Object.fromEntries(buildIntegrationTasks({ map, health: null, contextEnabled: false }).map((x) => [x.id, x]));
    expect(t.signup!.files).toEqual([{ path: "functions/src/auth/onUserCreated.ts", line: 12 }]);
    expect(t.deletion!.fromCode[0]).toContain("initiateAccountDeletion");
    expect(t.deletion!.files).toEqual([]); // unverified evidence isn't cited
    expect(t.preferences!.fromCode).toEqual(["Unsubscribe via `unsubscribedAll`."]);
    expect(t.steps!.files.map((f) => f.path)).toEqual(["src/app/api/tenants/create/route.ts", "functions/src/brand/scheduledSnapshot.ts"]); // steps, then facts
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
    expect(p).toContain("#### 1. [Required] Send sign-ups");
    expect(p).toContain("`functions/src/auth/onUserCreated.ts:12`");
    expect(p).toContain("https://yougrow.test/developers/users.md");
    expect(p).toContain("## Done when");
    expect(p).toContain("`GET https://yougrow.test/api/v2/users/{userId}` for a test account");
    expect(p).toContain("**Events** within seconds");
    expect(p).toContain("Journeys start in **test** mode");
  });

  it("uses the proposed steps and facts before anything is accepted into the catalog", () => {
    expect(p).toContain("`create_brand` — Create your brand; done when A brand settings doc exists (set it in the PATCH where the server makes this happen)");
    expect(p).toContain("`visibility` — AI visibility (%); from visibility_history");
  });

  it("names env vars and the public key id — never a secret", () => {
    expect(p).toContain("`YOUGROW_KEY_ID` (public, value `ygk_public_id`)");
    expect(p).toContain("`YOUGROW_SECRET`");
    expect(p).not.toMatch(/ygs_[A-Za-z0-9]/);
  });

  it("works in phases: plan and build sign-ups and compliance first, then stop", () => {
    expect(p).toContain("reply with a short plan for Phase 1 — at most 2 PRs — and wait for my OK");
    expect(p).toContain("Don't build a sync engine");
    const phase1 = p.slice(p.indexOf("### Phase 1"), p.indexOf("### Phase 2"));
    expect(phase1).toContain("[Required] Send sign-ups");
    expect(phase1).toContain("[Compliance] Handle account deletion");
    expect(phase1).toContain("[Compliance] Sync email preferences");
    expect(phase1).toContain("[Recommended] Send each user's timezone");
    expect(phase1).toContain("[Recommended] Exclude people who shouldn't get onboarding email");
    expect(phase1).not.toContain("[Personalisation]");
    const phase2 = p.slice(p.indexOf("### Phase 2"), p.indexOf("## What to send"));
    expect(phase2).toContain("[Personalisation] Report onboarding steps and facts");
    expect(phase2).toContain("[Personalisation] Build the context endpoint (optional)");
    expect(p).toContain("Treat them as leads, not facts");
  });

  it("gives typed values to send, never placeholders an agent could copy literally", () => {
    expect(p).toContain("## What to send (exact fields)");
    expect(p).toContain("- `signedUpAt` (ISO 8601 time) — When the account was created.");
    expect(p).toContain("- `subscribed` = `false` — When someone opts out");
    expect(p).toContain('- `excluded` = `{"reason":"staff"}` — For people who must never get lifecycle email');
    expect(p).toContain("On erasure: `DELETE https://yougrow.test/api/v2/users/{userId}`");
    expect(p).not.toContain("true | false");
  });

  it("labels Learn from repo's ids as proposals until they're accepted into the catalog", () => {
    expect(p).toContain("These step ids are **proposals**");
    expect(p).toContain("These fact ids are **proposals**");
    const accepted = buildIntegrationGuide({ connection: { ...connection, catalog: SANDBOX_CATALOG }, origin: "https://yougrow.test", productName: "vizzybl.ai" });
    expect(accepted.agentPrompt).not.toContain("These step ids are **proposals**");
    expect(accepted.agentPrompt).toContain("- `steps.create_brand` (ISO 8601 time) — When the brand has a name and a domain.");
    expect(accepted.agentPrompt).toContain("- `facts.share_of_voice` (number) — Share of voice (%), from Daily visibility snapshot.");
  });

  it("says where the contract is — the docs, the OpenAPI spec and the SDK, never YouGrow's source", () => {
    expect(p).toContain("Read https://yougrow.test/developers/llms-full.txt first");
    expect(p).toContain("https://yougrow.test/developers/openapi.json");
    expect(p).toContain("Don't clone or read YouGrow's own source code");
    expect(p).toContain("`YOUGROW_ORIGIN` (value `https://yougrow.test`)");
    expect(p).toContain("0.4.0 or later");
    expect(p).toContain('`const { YouGrow } = require("@yougrowai/node")`');
  });

  it("carries the protocol essentials for API v2, so it works even if the docs can't be reached", () => {
    expect(p).toContain("## Protocol essentials");
    expect(p).toContain("`PATCH https://yougrow.test/api/v2/users/{userId}`");
    expect(p).toContain("JSON Merge Patch");
    expect(p).toContain("HTTP Basic auth over HTTPS");
    expect(p).toContain("`POST https://yougrow.test/api/v2/users/batch`");
    expect(p).toContain('`200 {"applied":false,"reason":"stale_write"}`');
    expect(p).toContain("600 requests a minute and 20,000 an hour");
    expect(p).toContain("`iss` = `https://yougrow.test`");
    expect(p).toContain("Await every call");
    // API v1 is gone: no HMAC signing, messageIds, event batches or flushing.
    expect(p).not.toMatch(/api\/v1|x-yougrow-signature|x-yougrow-timestamp|HMAC|messageId|identify|flush\(|"batch":/i);
  });

  it("links only to pages and files that exist", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const urls = [...p.matchAll(/https:\/\/yougrow\.test[^\s`)"',]*/g)].map((m) => m[0].replace(/[.:]$/, ""));
    expect(urls.length).toBeGreaterThan(8);
    for (const url of urls) {
      const path = decodeURIComponent(new URL(url).pathname).replace(/\{(\w+)\}/g, "[$1]");
      if (path === "/") continue; // the origin itself is a value (YOUGROW_ORIGIN, iss), not a page
      const schema = /^\/developers\/schema\/([^/]+)$/.exec(path);
      if (schema) {
        expect(Object.keys(SCHEMAS), url).toContain(schema[1]);
        continue;
      }
      expect(existsSync(`${root}/src/app${path}/route.ts`), url).toBe(true);
    }
  });

  it("links nothing under /developers when this YouGrow doesn't publish docs", () => {
    const g = buildIntegrationGuide({ connection, analysis: { map }, origin: "https://yougrow.test", productName: "vizzybl.ai", docs: false });
    expect(g.agentPrompt).not.toContain("/developers");
    expect(g.agentPrompt).toContain("This YouGrow doesn't publish developer docs");
    expect(g.agentPrompt).toContain("## Protocol essentials");
    expect(g.docsUrl).toBeNull();
    expect(guide.docsUrl).toBe("https://yougrow.test/developers");
  });

  it("adds the optional invite-code task only while invites are on", () => {
    expect(buildIntegrationTasks({ map, health: null, contextEnabled: false }).map((t) => t.id)).not.toContain("invite");
    const withInvites = buildIntegrationTasks({ map, health: null, contextEnabled: false, invites: true });
    expect(withInvites.at(-1)).toMatchObject({ id: "invite", severity: "recommended", status: "todo" });
  });
});
