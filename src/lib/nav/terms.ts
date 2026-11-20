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
