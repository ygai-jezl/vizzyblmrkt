import { describe, expect, it } from "vitest";
import { companyReadOnly, personReadOnly, readOnlyFieldDefs } from "./readOnlyFields";

const AT = "2026-11-14T10:00:00.000Z";
const catalog = {
  events: [],
  onboardingSteps: [],
  glossary: [],
  entityKinds: [],
  traits: [{ key: "role", type: "string" as const, label: "Role in app", description: "" }, { key: "trial_ends", type: "timestamp" as const, label: "", description: "" }],
  facts: [
    { id: "projects", label: "Projects created", type: "number" as const, unit: null, description: "", source: "" },
    { id: "share", label: "Share of voice", type: "number" as const, unit: "%", description: "", source: "", kind: "brand" },
  ],
};
const app = { id: "pcn_1", name: "Acme App", catalog } as never;

describe("fields from elsewhere", () => {
  it("lists what a brand's launches, products, enrichment and voice chats bring, read only", () => {
    const defs = readOnlyFieldDefs("person", {
      campaigns: [{ id: "camp1", waitlistName: "Spring launch", questions: [{ question_value: "Your role?", optional: true, answer_value: null }], aiConversation: { enabled: true } as never }],
      connections: [app],
    });
    expect(defs.map((d) => [d.label, d.typeLabel, d.source, d.inFilters])).toEqual([
      ["Name, email, phone", "text", "YouGrow", "Search"],
      ["Your role?", "text", "Sign-up answer · Spring launch", "No"],
      ["Stage", "status", "Acme App", "Yes"],
      ["Role in app", "text", "Acme App trait", "No"],
      ["trial_ends", "date", "Acme App trait", "No"],
      ["Projects created", "number", "Acme App fact", "No"],
      ["Company size", "text", "Company enrichment", "No"],
      ["Voice chat", "text", "Sign-up voice chat", "No"],
    ]);
    expect(readOnlyFieldDefs("person", { campaigns: [], connections: [] }).map((d) => d.label)).not.toContain("Voice chat");
    expect(readOnlyFieldDefs("company", { campaigns: [], connections: [] }).every((d) => d.source === "YouGrow" || d.source === "Company enrichment")).toBe(true);
  });

  it("reads a person's answers from every sign-up, each product's stage, traits and facts, and their company's size", () => {
    const r = personReadOnly({
      signups: [
        {
          signup: { id: "s1", answers: [{ question_value: "Your role?", optional: true, answer_value: "Head of growth" }, { question_value: "Team size?", optional: true, answer_value: " " }] },
          launchName: "Spring launch",
        },
        { signup: { id: "s2", answers: [{ question_value: "Your role?", optional: true, answer_value: "Founder" }] }, launchName: "Autumn launch" },
      ],
      products: [{ connectionId: "pcn_1", productUserId: "pu_1", stage: "activated" }],
      users: [{ id: "pu_1", traits: { role: "admin", trial_ends: AT }, facts: { projects: { value: 9, at: AT }, share: { value: 12, at: AT } } }],
      connections: new Map([["pcn_1", app]]),
      company: { domain: "example.com", profile: { employeeRange: "51-200" } },
    });
    expect(r.values.map((v) => [v.label, v.value, v.source])).toEqual([
      ["Your role?", "Head of growth", "Sign-up answer · Spring launch"],
      ["Your role?", "Founder", "Sign-up answer · Autumn launch"],
      ["Stage", "Activated", "Acme App"],
      ["Role in app", "admin", "Acme App trait"],
      ["trial_ends", AT, "Acme App trait"],
      ["Projects created", "9", "Acme App fact"],
      ["Company size", "51 to 200", "Company enrichment"],
    ]);
    expect(r.values.find((v) => v.label === "trial_ends")?.kind).toBe("time");
    expect(r.voiceChats).toEqual([]);
  });

  it("gives a voice chat's summary and size, never what was said", () => {
    const r = personReadOnly({
      signups: [
        {
          signup: {
            id: "s1",
            aiConversation: { completed: true, transcript: [{ role: "user", text: "We export to sheets every Monday" }], summary: "Wants exports to Sheets.", capturedAt: AT, bonusApplied: true },
          },
          launchName: "Spring launch",
        },
        { signup: { id: "s2", aiConversation: { completed: false, transcript: [], capturedAt: AT, bonusApplied: false } }, launchName: "Autumn launch" },
      ],
      products: [],
      users: [],
      connections: new Map(),
      company: null,
    });
    expect(r.voiceChats).toEqual([{ signupId: "s1", launchName: "Spring launch", summary: "Wants exports to Sheets.", at: AT, turns: 1 }]);
    expect(JSON.stringify(r)).not.toContain("every Monday");
  });

  it("reads a company's enrichment, only what it has", () => {
    expect(companyReadOnly({ domain: "example.com", profile: { industry: "Software", employeeRange: "11-50", foundedYear: 2019 } }).map((v) => [v.label, v.value])).toEqual([
      ["Industry", "Software"],
      ["Company size", "11 to 50"],
      ["Founded", "2019"],
    ]);
    expect(companyReadOnly({ domain: "example.com", profile: null })).toEqual([]);
  });
});
