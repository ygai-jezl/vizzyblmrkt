/**
 * Vizzy drafts content plans from chat: the `content_plan` canvas kind and
 * /api/agent/content/*. Off = the agent's content tools say they're unavailable.
 * Agents only ever save drafts; approving and scheduling stay human.
 */
export function isContentChatAuthoringEnabled(): boolean {
  return process.env.CONTENT_CHAT_AUTHORING_ENABLED === "true";
}
