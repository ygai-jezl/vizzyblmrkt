import { describe, expect, it } from "vitest";
import { LifecycleSettingsSchema, type SentItem } from "@/lib/types/lifecycle";
import { emailCounts, personEmails, subjectPreview } from "./personEmails";
import { personTimeline } from "./personTimeline";

const at = (day: number, hour = 9) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const sent = (over: Partial<SentItem> = {}): SentItem => ({ nodeId: "email_1", poolId: "nudge", itemId: "a", at: at(1), status: "sent", mode: "live", ...over });
const journey = { id: "lcj_1", name: "Win-back", tracking: null };
const version = (tracking = { opens: true, clicks: true }) => ({
  pools: [{ id: "nudge", label: "Nudges", items: [{ id: "a", label: "N1 · We miss you", subject: "Still there, {{user.first_name|friend}}?", body: "", format: "branded" as const, messageClass: "marketing" as const, personalization: "none" as const }] }],
  settings: LifecycleSettingsSchema.parse({ tracking }),
});
const event = (over: Record<string, unknown>) => ({ journeyId: "lcj_1", nodeId: "email_1", variantId: "a", type: "open" as const, ts: at(1, 10), url: null, enrolmentId: null, ...over });

describe("personEmails", () => {
  it("gives each entry into a journey its own opens and clicks", () => {
    const first = { enrolment: { id: "enr_first", journeyId: "lcj_1", sentItems: [sent({ at: at(1) })] }, journey, version: version() };
    const again = { enrolment: { id: "enr_again", journeyId: "lcj_1", sentItems: [sent({ at: at(20), subject: "Still there, Priya?" })] }, journey, version: version() };
    const emails = personEmails(
      [again, first],
      [
        // From before rows named their enrolment: the first send of that step takes it.
        event({ ts: at(1, 10) }),
        event({ enrolmentId: "enr_again", ts: at(20, 11) }),
        event({ enrolmentId: "enr_again", type: "click", ts: at(20, 12), url: "https://app.example.com/reports" }),
      ],
      { firstName: "Priya", productName: "Fernlight" },
    );
    expect(emails.map((e) => e.enrolmentId)).toEqual(["enr_again", "enr_first"]); // newest first
    expect(emails[0]).toMatchObject({ subject: "Still there, Priya?", openedAt: at(20, 11), clickedAt: at(20, 12), clickUrl: "https://app.example.com/reports" });
    expect(emails[1]).toMatchObject({ subject: "Still there, Priya?", label: "N1 · We miss you", openedAt: at(1, 10), clickedAt: null });
    expect(emailCounts(emails)).toEqual({ sent: 2, opened: 2, clicked: 1, tracked: 2, trackedClicks: 2 });
  });

  it("gives an older open to the send it followed, not to the first send of that step", () => {
    // Both entries are from before rows named their enrolment: the first email was ignored, the second opened.
    const march = { enrolment: { id: "enr_march", journeyId: "lcj_1", sentItems: [sent({ at: "2026-03-02T09:00:00.000Z" })] }, journey, version: version() };
    const june = { enrolment: { id: "enr_june", journeyId: "lcj_1", sentItems: [sent({ at: "2026-06-02T09:00:00.000Z" })] }, journey, version: version() };
    const emails = personEmails([march, june], [event({ ts: "2026-06-02T10:00:00.000Z" })]);
    expect(emails.map((e) => [e.enrolmentId, e.openedAt])).toEqual([
      ["enr_june", "2026-06-02T10:00:00.000Z"],
      ["enr_march", null],
    ]);
    // A send that names its enrolment never takes an older row.
    const named = { ...june, enrolment: { ...june.enrolment, sentItems: [sent({ at: "2026-06-02T09:00:00.000Z", tracked: { opens: true, clicks: true } })] } };
    expect(personEmails([named], [event({ ts: "2026-06-02T10:00:00.000Z" })])[0]!.openedAt).toBeNull();
  });

  it("counts what could be seen: an email tracked for clicks alone can't be called unopened", () => {
    const clicksOnly = { opens: false, clicks: true };
    const entry = {
      enrolment: { id: "enr_1", journeyId: "lcj_1", sentItems: [1, 2, 3].map((n) => sent({ nodeId: `email_${n}`, at: at(n), tracked: clicksOnly })) },
      journey,
      version: version(clicksOnly),
    };
    const emails = personEmails([entry], [event({ enrolmentId: "enr_1", nodeId: "email_2", type: "click", ts: at(2, 10), url: "https://app.example.com/" })]);
    expect(emailCounts(emails)).toEqual({ sent: 3, opened: 1, clicked: 1, tracked: 0, trackedClicks: 3 });
  });

  it("never says an untracked email wasn't opened, and keeps a skipped one out of the counts", () => {
    const entry = {
      enrolment: {
        id: "enr_1",
        journeyId: "lcj_1",
        sentItems: [
          sent({ at: at(1) }), // before `tracked` was kept: what its version asked for
          sent({ nodeId: "email_2", at: at(3), mode: "shadow" }),
          sent({ nodeId: "email_3", at: at(5), status: "skipped", reason: "no_marketing_consent" }),
          sent({ nodeId: "email_4", at: at(7), status: "unknown", reason: "interrupted", tracked: { opens: true, clicks: false } }),
        ],
      },
      journey,
      version: version({ opens: false, clicks: false }),
    };
    const emails = personEmails([entry], [], {}).reverse();
    expect(emails.map((e) => e.tracked)).toEqual([
      { opens: false, clicks: false },
      { opens: false, clicks: false },
      { opens: false, clicks: false },
      { opens: true, clicks: false },
    ]);
    expect(emails.map((e) => e.note)).toEqual([null, null, "No marketing consent", "Interrupted: it may or may not have gone out"]);
    expect(emailCounts(emails)).toEqual({ sent: 3, opened: 0, clicked: 0, tracked: 1, trackedClicks: 0 });
  });

  it("shows a bounce and a complaint, and names an email whose version has gone", () => {
    const entry = { enrolment: { id: "enr_1", journeyId: "lcj_1", sentItems: [sent()] }, journey, version: null };
    const [email] = personEmails([entry], [event({ type: "bounce" }), event({ type: "spam" }), event({ type: "unsub" })]);
    expect(email).toMatchObject({ label: "a", subject: null, bounced: true, complained: true, unsubscribed: true, openedAt: null });
  });
});

describe("subjectPreview", () => {
  it("fills what we know and falls back for the rest", () => {
    expect(subjectPreview("Welcome to {{product.name}}, {{user.first_name|there}}", { productName: "Fernlight" })).toBe("Welcome to Fernlight, there");
    expect(subjectPreview("Hi {{ user.first_name }}, your {{fact.sov}} score", { firstName: "Priya" })).toBe("Hi Priya, your score");
    expect(subjectPreview("{{user.first_name}}, one step left", {})).toBe(", one step left");
  });
});

describe("personTimeline", () => {
  it("tells one story from the product, the journeys and the emails, newest first", () => {
    const moments = personTimeline({
      user: {
        signedUpAt: at(1, 8),
        firstSeenAt: at(1, 8),
        steps: { create_brand: { doneAt: at(2) } },
        entities: { b_1: { kind: "brand", name: "Harbour Bakery", parentId: null, role: "owner", steps: { connect_site: { doneAt: at(4) } }, facts: {}, activeAt: null, firstSeenAt: at(2, 8), updatedAt: at(4) } },
        milestones: {
          "user.signed_up": { firstAt: at(1, 8), lastAt: at(1, 8), count: 1 },
          "report.created": { firstAt: at(5), lastAt: at(8), count: 3 },
          "export.made": { firstAt: "2026-05-01T09:00:00.000Z", lastAt: "2026-05-01T09:00:00.000Z", count: 1 },
        },
        activatedAt: at(5),
        emailPreferences: { digest: { subscribed: false, at: at(9) } },
      },
      catalog: {
        onboardingSteps: [
          { id: "create_brand", label: "Add your brand", order: 0 },
          { id: "connect_site", label: "Connect your site", order: 1, kind: "brand" },
        ],
        events: [{ name: "report.created", label: "Ran a report", description: "" }],
        entityKinds: [{ kind: "brand", label: "brand", plural: "brands", multiple: true, description: "" }],
      },
      events: [
        { type: "track", event: "report.created", timestamp: at(5), applied: true, entityId: "b_1" },
        { type: "track", event: "report.created", timestamp: at(8), applied: true, entityId: null },
        { type: "track", event: "user.signed_up", timestamp: at(1, 8), applied: true, entityId: null },
        { type: "identify", event: null, timestamp: at(8), applied: true, entityId: null },
      ],
      journeys: [],
      emails: [],
      optOuts: [{ scope: "category", reason: "unsubscribe", category: "tips", createdAt: at(9, 12) }],
      categoryLabels: { tips: "Product tips" },
    });
    expect(moments.map((m) => [m.kind, m.text, m.detail])).toEqual([
      ["stop", "Opted out of Product tips", null],
      ["stop", "Opted out of digest in your product", null],
      ["product", "Ran a report", null],
      ["product", "Ran a report", "Harbour Bakery"],
      ["product", "Finished onboarding", null],
      ["product", "Finished Connect your site", "Harbour Bakery"],
      ["product", "Finished Add your brand", null],
      ["product", "Added brand Harbour Bakery", null],
      ["product", "Signed up", null],
      // Older than the events we still hold: its first time, from the milestone.
      ["product", "export.made", null],
    ]);
  });
});
