/**
 * The agents that propose. "lifecycle" is for the AI lines follow-up; "learning" is the learning
 * loops' lane, which offers to go back to an earlier learned look (learning loops step 4). Kept
 * apart from ./agentAction.ts so a stamp (./loopStamp.ts) can name its agent and an agent action
 * can keep its stamp without the two files importing each other.
 */
export const AGENT_NAMES = ["vizzy", "autopilot", "connector_signals", "lifecycle", "learning"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
