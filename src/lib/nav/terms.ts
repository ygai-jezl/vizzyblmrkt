import { isNavV2Phase3Enabled } from "./flags";

/**
 * What a content workspace is called in the UI. Nav v2 phase 3 renames it
 * "programme" — one line of content such as a newsletter or a LinkedIn series —
 * because "workspace" usually means the whole account. Routes, APIs and data
 * keep "workspace"; only the words people read change.
 */
export function programmeWord(): { one: string; One: string; many: string } {
  return isNavV2Phase3Enabled()
    ? { one: "programme", One: "Programme", many: "programmes" }
    : { one: "workspace", One: "Workspace", many: "workspaces" };
}

/**
 * What the Audience area is called: "People" when `on` (isPeopleNameEnabled(), worked out on the
 * server and passed down), else "Audience". Unlike programmeWord() it takes the answer, because
 * half of the rule (the one People list) is a server switch. Routes, APIs and data keep "audience".
 */
export function peopleArea(on: boolean): "People" | "Audience" {
  return on ? "People" : "Audience";
}

/** A launch's name in the words people read, with its article and possessive, so sentences stay grammatical. */
export interface IdeaWord {
  one: "idea" | "launch";
  One: "Idea" | "Launch";
  many: "ideas" | "launches";
  Many: "Ideas" | "Launches";
  /** "an idea" or "a launch". */
  a: "an idea" | "a launch";
  A: "An idea" | "A launch";
  /** "idea's" or "launch's". */
  own: "idea's" | "launch's";
  /** "ideas'" or "launches'". */
  manyOwn: "ideas'" | "launches'";
}

const IDEA: IdeaWord = { one: "idea", One: "Idea", many: "ideas", Many: "Ideas", a: "an idea", A: "An idea", own: "idea's", manyOwn: "ideas'" };
const LAUNCH: IdeaWord = {
  one: "launch",
  One: "Launch",
  many: "launches",
  Many: "Launches",
  a: "a launch",
  A: "A launch",
  own: "launch's",
  manyOwn: "launches'",
};

/**
 * What a launch is called: "idea" when `on` (isIdeaWordsEnabled(), worked out on the server and
 * passed down; useWords().ideas in client components), else "launch". Like peopleArea() it takes
 * the answer, because half of the rule (LAUNCH_IDEAS_ENABLED) is a server switch. Routes, APIs and
 * data keep "launch" and `campaigns`. A message a help page quotes is written out as a literal
 * pair instead, so the help test finds it in the source.
 */
export function ideaWord(on: boolean): IdeaWord {
  return on ? IDEA : LAUNCH;
}

/**
 * The line under the Audience or People title. With the one People list it says who is on it, and
 * names people the team added only while New person is on (`addedByTeam`). Before nav phase 3,
 * the old Unified CRM line.
 */
export function peopleSubtitle(opts: { phase3: boolean; oneView: boolean; addedByTeam: boolean }): string {
  if (!opts.phase3) return "Every contact across all launches, with company intelligence and email history.";
  if (!opts.oneView) return "Everyone you reach: your launches' signups, your product's users, and the companies and people engaging with your content.";
  return opts.addedByTeam ? "Everyone who signed up, uses your product or was added by your team." : "Everyone who signed up or uses your product.";
}
