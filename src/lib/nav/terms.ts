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
