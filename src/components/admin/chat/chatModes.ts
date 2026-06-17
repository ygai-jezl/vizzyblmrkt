/**
 * Reasoning modes for the dashboard root agent. "Thinking" trades latency for
 * deliberate multi-step reasoning; "Fast" is snappier for simple asks. The mode
 * is sent to the agent proxy and applied server-side via the `[mode:…]` envelope
 * prefix (see agents/root-agent-py/callbacks/chat_mode.py in Phase 2+).
 */
export type ChatMode = "thinking" | "fast";

export interface ChatModeConfig {
  id: ChatMode;
  label: string;
  description: string;
}

export const THINKING_MODE: ChatModeConfig = {
  id: "thinking",
  label: "Thinking",
  description: "Deliberate, multi-step reasoning for complex tasks.",
};

export const FAST_MODE: ChatModeConfig = {
  id: "fast",
  label: "Fast",
  description: "Quick responses for straightforward questions.",
};

export const CHAT_MODES: readonly ChatModeConfig[] = [THINKING_MODE, FAST_MODE];

export const DEFAULT_CHAT_MODE: ChatMode = "thinking";

/** Resolve a mode id to its config, always returning a concrete config. */
export function getChatMode(id: ChatMode): ChatModeConfig {
  return id === "fast" ? FAST_MODE : THINKING_MODE;
}
