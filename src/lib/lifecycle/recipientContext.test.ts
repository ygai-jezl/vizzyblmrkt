import { describe, expect, it } from "vitest";
import type { ProductContext } from "@/lib/connect/protocol";
import type { ProductUser } from "@/lib/types/productUser";
import { buildRecipientContext, buildRenderValues } from "./recipientContext";
import { renderLifecycleEmail } from "./render";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const fact = (id: string, type: "date" | "number") => ({ id, label: id === "last_active_at" ? "Last active" : "Share of voice", type, unit: type === "number" ? "%" : null, description: "", source: "" });
const connection = {
  name: "Acme",
  linkDomains: [],
  defaults: { timezone: "Europe/London", locale: "en-GB" },
  catalog: { events: [], traits: [], onboardingSteps: [], glossary: [], entityKinds: [], facts: [fact("last_active_at", "date"), fact("share_of_voice", "number")] },
};
const user = (patch: Partial<ProductUser> = {}) =>
  ({
    externalUserId: "u_1",
    firstName: "Alex",
    traits: {},
    steps: {},
    milestones: {},
    consent: null,
    facts: { last_active_at: { value: "2026-09-24T23:30:00Z", at: "2026-09-25T05:30:00Z" }, share_of_voice: { value: 12, at: "2026-09-25T05:30:00Z" } },
    ...patch,
  }) as unknown as ProductUser;
const footer = { brand: "Acme", unsubscribeUrl: "#", managePreferencesUrl: "#", privacyUrl: "#" };

function values(u: ProductUser, context: ProductContext | null = null) {
  const rc = buildRecipientContext({ user: u, connection, context, emailsSent: 0, enrolledAtMs: NOW, nowMs: NOW });
  return buildRenderValues({ user: u, connection, rc, context, insight: null, footer });
}
const display = (v: ReturnType<typeof values>, id: string) => v.facts.find((f) => f.id === id)?.display ?? null;

describe("a date fact in an email", () => {
  it("prints as a date in the reader's language and time zone, never as the raw text", () => {
    expect(display(values(user()), "last_active_at")).toBe("25 September 2026"); // 23:30 UTC is the 25th in London
    expect(display(values(user({ locale: "en-US", timezone: "America/New_York" })), "last_active_at")).toBe("September 24, 2026");
    expect(display(values(user()), "share_of_voice")).toBeNull(); // other facts print as before
    const email = renderLifecycleEmail({
      item: { subject: "Since {{fact.last_active_at}}", body: "You were last in on {{fact.last_active_at}}.", format: "letter" },
      values: values(user()),
    });
    expect(email.subject).toBe("Since 25 September 2026");
    expect(email.text).toContain("You were last in on 25 September 2026.");
  });

  it("keeps the product's own display when its live answer gives one", () => {
    const live = (f: object) => ({ asOf: "2026-10-08T12:00:00Z", steps: [], insights: [], facts: [{ id: "last_active_at", label: "Last active", value: "2026-10-01T08:00:00Z", ...f }] }) as unknown as ProductContext;
    expect(display(values(user(), live({ display: "last Thursday" })), "last_active_at")).toBe("last Thursday");
    expect(display(values(user(), live({})), "last_active_at")).toBe("1 October 2026");
  });
});
