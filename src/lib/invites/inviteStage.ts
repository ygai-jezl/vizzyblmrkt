/** A person's furthest invite stage, and its label (pure: shared by Audience's server and client code). */
export type InviteStage = "invited" | "signed_up" | "activated";

export const INVITE_STAGE_LABEL: Record<InviteStage, string> = {
  invited: "Invited",
  signed_up: "Signed up",
  activated: "Activated",
};
