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

from . import _project_fix  # noqa: F401  MUST precede google-auth — see _project_fix.py
from google.adk.agents import LlmAgent

from .callbacks.chat_mode import apply_chat_mode
from .callbacks.context_envelope import apply_context_envelope
from .context.brand_context import build_dynamic_instruction
from .model_config import DEFAULT_MODEL
from .sub_agents.campaign_ops.agent import campaign_ops_agent
from .sub_agents.lifecycle_ops.agent import lifecycle_ops_agent
from .sub_agents.content_ops.agent import content_ops_agent
from .tools.retrieve_knowledge import retrieve_knowledge
from .tools.insights_summary import get_insights_summary

root_agent = LlmAgent(
    name="vizzybl_marketing_root",
    model=DEFAULT_MODEL,
    description=(
        "YouGrow.ai root orchestrator — GTM command center for launches, "
        "email broadcasts/journeys, creative, signups, and analytics."
    ),
    instruction=build_dynamic_instruction,
    # Order matters: strip the [ctx:] envelope first, then the [mode:] directive.
    before_model_callback=[apply_context_envelope, apply_chat_mode],
    # retrieve_knowledge grounds answers on the launch's ingested docs/site/repos
    # (RAG); get_insights_summary answers "how are we doing?" from the Insights
    # numbers (aggregates only). More marketing FunctionTools land alongside them.
    tools=[retrieve_knowledge, get_insights_summary],
    # campaign_ops authors launch (waitlist) journeys; lifecycle_ops authors
    # connected-product lifecycle journeys. Both save drafts only.
    sub_agents=[campaign_ops_agent, lifecycle_ops_agent, content_ops_agent],
)
