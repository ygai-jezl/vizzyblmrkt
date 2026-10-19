"""Vizzybl Marketing root orchestrator — ADK 2.0 LlmAgent.

The dashboard chat's backend: an LLM-driven orchestrator deployed to the Gemini
Enterprise Agent Platform / Agent Runtime as a reasoningEngine. The Next.js proxy
invokes it via `:streamQuery`, passing tenant/user context as a `[ctx:{...}]`
message prefix (see callbacks/context_envelope.py) and the reasoning mode as a
`[mode:fast|thinking]` prefix (see callbacks/chat_mode.py).

It has root FunctionTools and three sub-agents (campaign_ops, lifecycle_ops,
content_ops). Every tool calls back to the app's /api/agent/* routes with the
signed `ctxToken` from the envelope; see README.md.

Sessions + Memory Bank are provided by Agent Runtime. The engine runs as a
dedicated service account (`identity_type=SERVICE_ACCOUNT`, rendered into
.agent_engine_config.json by deploy.sh). Memory is scoped per tenant per user
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
from .tools.email_style import get_email_style, suggest_email_style
from .tools.image_style import get_image_style, suggest_image_style
from .tools.journey_style import get_journey_email_style, set_journey_email_style
from .tools.brand_map import get_brand_map, suggest_brand_map
from .tools.brand_notes import get_brand_notes, suggest_brand_notes
from .tools.setup_help import get_setup_status, read_help_page

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
    # numbers (aggregates only); get/suggest_email_style read the brand-wide Email
    # style and save a suggestion an admin applies; get/set_journey_email_style read
    # and set one journey's own look, in its draft (Lifecycle Ops has them too);
    # get/suggest_image_style read the brand's image style and save a suggestion an admin applies;
    # get_brand_map/suggest_brand_map read the brand map and file suggestions an admin
    # accepts; get_brand_notes/suggest_brand_notes read What we've seen and file suggested
    # notes in the person's own words; get_setup_status/read_help_page answer "what should I set up first?"
    # and "how do I…?" from the brand's setup progress and the help pages. More
    # marketing FunctionTools land alongside them.
    tools=[
        retrieve_knowledge,
        get_insights_summary,
        get_email_style,
        suggest_email_style,
        get_image_style,
        suggest_image_style,
        get_journey_email_style,
        set_journey_email_style,
        get_brand_map,
        suggest_brand_map,
        get_brand_notes,
        suggest_brand_notes,
        get_setup_status,
        read_help_page,
    ],
    # campaign_ops authors launch (waitlist) journeys; lifecycle_ops authors
    # connected-product lifecycle journeys. Both save drafts only.
    sub_agents=[campaign_ops_agent, lifecycle_ops_agent, content_ops_agent],
)
