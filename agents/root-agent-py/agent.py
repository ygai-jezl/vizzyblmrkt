"""Vizzybl Marketing root orchestrator — ADK 2.0 LlmAgent.

The dashboard chat's backend: an LLM-driven orchestrator deployed to the Gemini
Enterprise Agent Platform / Agent Runtime as a reasoningEngine. The Next.js proxy
invokes it via `:streamQuery`, passing tenant/user context as a `[ctx:{...}]`
message prefix (see callbacks/context_envelope.py) and the reasoning mode as a
`[mode:fast|thinking]` prefix (see callbacks/chat_mode.py).

Phase 2: instruction + context/mode callbacks only — no tools or sub-agents yet.
Marketing-native FunctionTools and co-located sub-agents (creative, analytics)
land in Phase 3; third-party MCP toolsets in Phase 4.

Sessions + Memory Bank + Agent Identity are provided by Agent Runtime when this
agent is deployed as an AdkApp with `identity_type=AGENT_IDENTITY`
(see .agent_engine_config.json + deploy.sh). Memory is scoped per-tenant-per-user
by the composite `user_id` the proxy sends (see context/memory_config.py).
"""

from __future__ import annotations

import os

from google.adk.agents import LlmAgent

from .callbacks.chat_mode import apply_chat_mode
from .callbacks.context_envelope import apply_context_envelope
from .context.brand_context import build_dynamic_instruction

# Flash for speed/cost; thinking is selected per-request via the [mode:] prefix.
DEFAULT_MODEL = os.environ.get("ROOT_AGENT_MODEL", "gemini-3.5-flash")

root_agent = LlmAgent(
    name="vizzybl_marketing_root",
    model=DEFAULT_MODEL,
    description=(
        "Vizzybl Marketing root orchestrator — GTM command center for launches, "
        "email broadcasts/journeys, creative, signups, and analytics."
    ),
    instruction=build_dynamic_instruction,
    # Order matters: strip the [ctx:] envelope first, then the [mode:] directive.
    before_model_callback=[apply_context_envelope, apply_chat_mode],
    tools=[],  # Phase 3 adds marketing FunctionTools + AgentTool sub-agents.
    sub_agents=[],  # Phase 3 adds creative_agent / analytics_agent.
)
