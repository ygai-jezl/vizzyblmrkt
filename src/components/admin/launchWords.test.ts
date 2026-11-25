import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultCampaignSettings } from "@/lib/admin/campaignSettings";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { IDEA_MESSAGES, ideaErrorText, ideaMessages } from "@/lib/ideas/words";
import { INVITE_LOCK_TEXT, inviteLockText } from "@/lib/invites/lockText";

// The launch screens' client components name a launch, or an idea while the words are on, read
// from WordsProvider (the admin layout wraps every page in it). Rendered here inside it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { WordsProvider } = await import("./nav/WordsProvider");
const { NewLaunchForm } = await import("./NewLaunchForm");
const { ArchiveLaunchSection } = await import("./ArchiveLaunchSection");
const { DeleteLaunchSection } = await import("./DeleteLaunchSection");
const { CampaignSettingsForm } = await import("./CampaignSettingsForm");
const { WidgetBuilder } = await import("./WidgetBuilder");
const { ComparePicks } = await import("./ideas/ComparePicks");

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
