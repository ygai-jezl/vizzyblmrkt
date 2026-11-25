import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultCampaignSettings } from "@/lib/admin/campaignSettings";
import type { PeopleFilters } from "@/lib/audience/peopleList";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { IDEA_MESSAGES, ideaErrorText, ideaMessages } from "@/lib/ideas/words";
import { INVITE_LOCK_TEXT, inviteLockText } from "@/lib/invites/lockText";
import { LifecycleSettingsSchema } from "@/lib/types/lifecycle";
import type { Journey } from "@/lib/types/journey";
import type { JourneyDetail } from "./lifecycle/model";

// The launch screens' client components name a launch, or an idea while the words are on, read
// from WordsProvider (the admin layout wraps every page in it). Rendered here inside it: the
// launch pages, Insights, People, journeys, email and Brand.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/analytics/launches",
  useSearchParams: () => new URLSearchParams(),
}));
const { WordsProvider } = await import("./nav/WordsProvider");
const { NewLaunchForm } = await import("./NewLaunchForm");
const { ArchiveLaunchSection } = await import("./ArchiveLaunchSection");
const { DeleteLaunchSection } = await import("./DeleteLaunchSection");
const { CampaignSettingsForm } = await import("./CampaignSettingsForm");
const { WidgetBuilder } = await import("./WidgetBuilder");
const { ComparePicks } = await import("./ideas/ComparePicks");
const { InsightsTabs } = await import("./insights/InsightsTabs");
const { PeopleFilterBar } = await import("./audience/PeopleFilterBar");
const { BroadcastsView } = await import("./email/BroadcastsView");
const { WeeklyClient } = await import("./workspace/weekly/WeeklyClient");
const { SettingsPanel } = await import("./lifecycle/SettingsPanel");
const { DeliveryPanel } = await import("./lifecycle/DeliveryPanel");
const { PoolsEditor } = await import("./lifecycle/PoolsEditor");
const { JourneyCanvas } = await import("./journey/JourneyCanvas");
const { ImageStyleCard } = await import("./brand-kit/ImageStyleCard");

/** The words people read: tags gone, entities back. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const inside = (ideas: boolean, el: ReactElement) =>
  renderToStaticMarkup(createElement(WordsProvider, { ideas } as Parameters<typeof WordsProvider>[0], el));

const screens: Array<[string, ReactElement]> = [
  ["New launch", createElement(NewLaunchForm, { hypothesis: true })],
  ["Archive", createElement(ArchiveLaunchSection, { campaignId: "team-spaces", campaignName: "Team spaces", archived: false })],
  ["Restore", createElement(ArchiveLaunchSection, { campaignId: "team-spaces", campaignName: "Team spaces", archived: true })],
  ["Delete", createElement(DeleteLaunchSection, { campaignId: "team-spaces", campaignName: "Team spaces" })],
  [
    "Settings",
    createElement(CampaignSettingsForm, {
      campaignId: "team-spaces",
      initial: { ...defaultCampaignSettings(), waitlistName: "Team spaces" },
      senderConfig: { senderName: "Lumen Notes" } as Parameters<typeof CampaignSettingsForm>[0]["senderConfig"],
    }),
  ],
  [
    "Page & widget",
    createElement(WidgetBuilder, {
      origin: "https://yougrow.test",
      embedOrigin: "https://yougrow.test",
      tenantId: "ten_A",
      campaigns: [{ id: "team-spaces", waitlistName: "Team spaces", settings: { ...defaultCampaignSettings(), waitlistName: "Team spaces" } }],
      initialCampaignId: "team-spaces",
    }),
  ],
  ["Compare picks", createElement(ComparePicks)],
];

const noop = () => {};
const waitlistJourney = {
  audience: "waitlist",
  journey: { id: "lcjw_team-spaces", deliveryMode: "test", testRecipients: { userIds: [], emails: [] }, shadowInbox: null, caps: { sendsPerDay: 500, enrolmentsPerDay: 500 } },
  connection: null,
  sender: { verified: true, fromEmail: "hello@lumen.example.com", fromName: "Lumen Notes" },
  postalAddress: "1 Example Street",
  modeCeiling: "live",
} as unknown as JourneyDetail;
const originalJourney = { id: "journey_team-spaces", campaignId: "team-spaces", tenantId: "ten_A", status: "paused", graph: { nodes: [], edges: [] } } as unknown as Journey;
const peopleFilters: PeopleFilters = {
  everyone: 120,
  canEmail: 90,
  via: { form: 100, site: 0 },
  launches: [{ id: "team-spaces", name: "Team spaces", count: 70 }],
  products: [],
  manyLaunches: 38,
};

/**
 * The rest of the main launch screens (D2b), each with a line it says today with the words off.
 * Each says it again outside WordsProvider, so pages the provider doesn't wrap keep today's words.
 */
const more: Array<[string, ReactElement, string]> = [
  ["Insights tabs", createElement(InsightsTabs, { market: false }), "Overview Launches Email"],
  [
    "People filters",
    createElement(PeopleFilterBar, { filters: peopleFilters, show: "all", search: "", canEmail: false, group: null, onPick: noop, onCanEmail: noop }),
    "In more than one launch 38",
  ],
  ["Broadcasts", createElement(BroadcastsView, { campaignId: "team-spaces", initial: [] }), "No broadcasts yet. Create one to email this launch's subscribers."],
  ["Weekly newsletter", createElement(WeeklyClient, { workspaceId: "ws_1", hubs: [], campaigns: [] }), "It goes to the launch's weekly subscribers"],
  [
    "Welcome journey settings",
    createElement(SettingsPanel, {
      settings: LifecycleSettingsSchema.parse({}),
      catalog: undefined,
      sender: { verified: true, fromEmail: "hello@lumen.example.com", fromName: "Lumen Notes" },
      readOnly: true,
      onChange: noop,
      waitlist: { launchId: "team-spaces", launchName: "Team spaces" },
    }),
    "Welcome emails come from the launch's sender, set in the launch's settings",
  ],
  ["Welcome journey delivery", createElement(DeliveryPanel, { detail: waitlistJourney, canEdit: true, onSaved: noop }), "Real emails to everyone who joins, from the launch's sender."],
  [
    "Welcome journey content",
    createElement(PoolsEditor, {
      pools: [],
      fields: [],
      catalog: undefined,
      productName: "Team spaces",
      brand: "Lumen Notes",
      postalAddress: null,
      readOnly: true,
      focusPoolId: null,
      onFocusPool: noop,
      onChange: noop,
      waitlist: true,
    }),
    "{{waitlist_name}} The launch's product name",
  ],
  ["Original journey editor", createElement(JourneyCanvas, { campaignId: "team-spaces", initial: originalJourney, readOnly: true }), "Move this launch to the new engine"],
  ["Image style", createElement(ImageStyleCard, { initial: null, suggestion: null, palette: [], canEdit: true }), "Launch email hero"],
];

// Image style names a launch's email a waitlist email while the words are on, so it says neither.
const NO_IDEA_WORD = new Set(["Page & widget", "Image style"]);

// "Launch" in its general sense: the campaign goals in Settings.
const GENERAL = /Build Pre-Launch Waitlist|Direct Product Launch \/ GA/g;

// Page & widget's design tab names neither; its launch lines are on the Hosted and Your own form choices.
const naming = screens.filter(([name]) => name !== "Page & widget");

describe("the launch screens' words", () => {
  it("say idea, never launch, inside WordsProvider with the words on", () => {
    for (const [name, el] of screens) {
      const t = text(inside(true, el)).replace(GENERAL, "");
      expect(t, name).not.toMatch(/\blaunch/i);
      if (name !== "Page & widget") expect(t, name).toMatch(/\bidea/i);
    }
  });

  it("say launch with the words off, and outside WordsProvider", () => {
    for (const [name, el] of naming) {
      expect(text(inside(false, el)).replace(GENERAL, ""), name).toMatch(/\blaunch/i);
      expect(text(renderToStaticMarkup(el)).replace(GENERAL, ""), name).toMatch(/\blaunch/i);
    }
  });

  it("name the parts people act on", () => {
    const newIdea = text(inside(true, createElement(NewLaunchForm, { hypothesis: true })));
    expect(newIdea).toContain("Idea name");
    expect(newIdea).toContain("Create idea");
    expect(newIdea).toContain("You can fine-tune everything else in the idea's Settings tab.");
    const newLaunch = text(inside(false, createElement(NewLaunchForm, { hypothesis: true })));
    expect(newLaunch).toContain("Launch name");
    expect(newLaunch).toContain("Create launch");
    expect(text(inside(true, screens[1]![1]))).toContain("Archive idea");
    expect(text(inside(true, screens[3]![1]))).toContain("Permanently delete idea");
    expect(text(inside(true, createElement(ComparePicks)))).toBe("Tick 2 to 4 ideas to compare them side by side.");
  });

  it("keep house style in both words", () => {
    for (const ideas of [true, false]) {
      for (const [name, el] of [screens[0]!, screens[1]!, screens[2]!, screens[3]!, screens[6]!]) {
        const t = text(inside(ideas, el));
        expect(dashesIn(t), `${name} ${ideas}`).toEqual([]);
        expect(aiTellsIn(t), `${name} ${ideas}`).toEqual([]);
      }
    }
  });
});

describe("the main launch screens inside WordsProvider", () => {
  const all: Array<[string, ReactElement]> = [...screens, ...more.map(([name, el]) => [name, el] as [string, ReactElement])];

  it("show no Launch with the words on, and name an idea", () => {
    for (const [name, el] of all) {
      const t = text(inside(true, el)).replace(GENERAL, "");
      expect(t, name).not.toMatch(/\blaunch/i);
      if (!NO_IDEA_WORD.has(name)) expect(t, name).toMatch(/\bidea/i);
    }
  });

  it("show today's words with the words off, inside WordsProvider or outside it", () => {
    for (const [name, el, today] of more) {
      expect(text(inside(false, el)), name).toContain(today);
      expect(text(renderToStaticMarkup(el)), name).toContain(today);
      expect(inside(false, el), name).toBe(renderToStaticMarkup(el));
    }
    for (const [name, el] of screens) expect(inside(false, el), name).toBe(renderToStaticMarkup(el));
  });

  it("name what the words-on screens say", () => {
    const on = (name: string) => text(inside(true, more.find(([n]) => n === name)![1]));
    expect(on("Insights tabs")).toContain("Overview Ideas Email");
    expect(on("People filters")).toContain("In more than one idea 38");
    expect(on("Broadcasts")).toContain("One-off emails to this idea's audience.");
    expect(on("Weekly newsletter")).toContain("It goes to the idea's weekly subscribers: the people who reached a “weekly” Exit node in that idea's journey.");
    expect(on("Welcome journey settings")).toContain("Welcome emails come from the idea's sender, set in the idea's settings (or your Domains settings).");
    expect(on("Welcome journey delivery")).toContain("Real emails to everyone who joins, from the idea's sender.");
    expect(on("Welcome journey content")).toContain("{{waitlist_name}} The idea's product name");
    expect(on("Original journey editor")).toContain("Move this idea to the new engine");
    expect(on("Image style")).toContain("Waitlist email hero");
  });

  it("keep house style in what they say about ideas", () => {
    for (const [name, el] of more) {
      const sentences = text(inside(true, el))
        .split(/(?<=[.?!])\s+/)
        .filter((s) => /\bidea/i.test(s));
      for (const s of sentences) {
        expect(dashesIn(s), `${name}: ${s}`).toEqual([]);
        expect(aiTellsIn(s), `${name}: ${s}`).toEqual([]);
      }
    }
  });
});

describe("the messages help quotes, in both words", () => {
  it("are written out in full, with the launch ones unchanged", () => {
    expect(ideaMessages(false)).toBe(IDEA_MESSAGES);
    expect(ideaMessages(true).hypothesisNotSaved).toBe("Your idea is made. Add the hypothesis on its Overview.");
    expect(ideaMessages(true).closeFailed).toContain("use Archive idea on the Settings tab.");
    expect(ideaErrorText("not_launched", true)).toBe(IDEA_MESSAGES.notLaunched);
    expect(ideaErrorText("nope")).toBe(IDEA_MESSAGES.notSaved);
  });

  it("say why inviting is locked in the words in use", () => {
    expect(inviteLockText("launch_archived", false)).toBe("This launch is archived.");
    expect(inviteLockText("launch_archived", true)).toBe("This idea is archived.");
    expect(inviteLockText("no_product", true)).toBe(INVITE_LOCK_TEXT.no_product);
  });
});
