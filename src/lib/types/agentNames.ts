/**
 * The agents that propose. "lifecycle" is for the AI lines follow-up. "research" is brand map
 * research and learning from a repo, whoever pressed it (the record's requestedBy says who; agent
 * record, ADR-0026). "raise_followups" is YouGrow's follow-up rule on the investor and funding board.
 * "paste" is the code that reads a list pasted on People into one card (RAISE_PASTE_ENABLED), as
 * "connector_signals" reads collected numbers.
 * "learning" is the learning loops' lane, which offers to go back to an earlier learned look
 * (learning loops step 4). Kept apart from ./agentAction.ts so a stamp
 * (./loopStamp.ts) can name its agent and an agent action can keep its stamp without the two files
 * importing each other.
 */
export const AGENT_NAMES = ["vizzy", "autopilot", "connector_signals", "lifecycle", "research", "raise_followups", "paste", "learning"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
