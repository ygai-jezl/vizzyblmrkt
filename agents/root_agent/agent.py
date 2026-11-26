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

from .callbacks.business_profile import apply_business_profile
from .callbacks.chat_mode import apply_chat_mode
from .callbacks.context_envelope import apply_context_envelope
from .context.brand_context import build_dynamic_instruction
from .model_config import DEFAULT_MODEL
from .sub_agents.campaign_ops.agent import campaign_ops_agent
from .sub_agents.lifecycle_ops.agent import lifecycle_ops_agent
from .sub_agents.content_ops.agent import content_ops_agent
from .tools.retrieve_knowledge import retrieve_knowledge
from .tools.insights_summary import get_insights_summary
from .tools.audience_counts import get_audience_counts
from .tools.email_style import get_email_style, suggest_email_style
from .tools.image_style import get_image_style, suggest_image_style
from .tools.journey_style import get_journey_email_style, set_journey_email_style
from .tools.brand_map import get_brand_map, suggest_brand_map
from .tools.brand_notes import get_brand_notes, suggest_brand_notes
from .tools.competitors import get_competitors
from .tools.search import search_brand
from .tools.results import get_email_results, get_post_results
from .tools.connectors import get_connected_numbers, get_number_suggestions, list_connections, read_connected_live
from .tools.context_pack import get_brand_context
from .tools.next_up import get_next_up
from .tools.brand_strategy import get_brand_strategy
from .tools.content_strategy import get_content_strategy
from .tools.usage import get_usage
from .tools.articles_due import list_articles_due
from .tools.article_review import review_article
from .tools.setup_help import get_setup_status, read_help_page
from .tools.new_person import new_person_propose
from .tools.business_profile import get_business_profile, read_onboarding_conversation, suggest_business_fact
from .tools.work import draft_work_decision, draft_work_log, get_work, suggest_work_task

root_agent = LlmAgent(
    name="vizzybl_marketing_root",
    model=DEFAULT_MODEL,
    description=(
        "YouGrow.ai root orchestrator — GTM command center for launches, "
        "email broadcasts/journeys, creative, signups, and analytics."
    ),
    instruction=build_dynamic_instruction,
    # Order matters: strip the [ctx:] envelope first, then the [mode:] directive, then append
    # what the brand told Vizzy (it needs the envelope's profileRev; see callbacks/business_profile.py).
    before_model_callback=[apply_context_envelope, apply_chat_mode, apply_business_profile],
    # retrieve_knowledge grounds answers on the launch's ingested docs/site/repos
    # (RAG); get_insights_summary answers "how are we doing?" from the Insights
    # numbers (aggregates only); get_audience_counts counts the audience by launch,
    # product and stage (counts only, never a person); get/suggest_email_style read the brand-wide Email
    # style and save a suggestion an admin applies; get/set_journey_email_style read
    # and set one journey's own look, in its draft (Lifecycle Ops has them too);
    # get/suggest_image_style read the brand's image style and save a suggestion an admin applies;
    # get_brand_map/suggest_brand_map read the brand map and file suggestions an admin
    # accepts; get_brand_notes/suggest_brand_notes read What we've seen and file suggested
    # notes in the person's own words; get_competitors reads Brand › Competitors (read only);
    # search_brand searches everything the brand wrote, by words and meaning (read only);
    # get_email_results/get_post_results read how emails and posts did, each number explained;
    # list_connections/read_connected_live read connected data (Cloudflare, Search Console,
    # Google Analytics) live, only where an admin let Vizzy read it, each number explained;
    # get_connected_numbers reads the numbers YouGrow collects daily for the same connections, for
    # decisions (read only, same grants); get_number_suggestions lists what those numbers suggest
    # (read only; a person acts on each in Review or on the brand map);
    # get_brand_context reads everything the brand knows about one question (read only);
    # get_next_up reads the brand's three best next articles, with why (read only);
    # get_brand_strategy reads the brand's approved strategy, each claim with its proof (read only);
    # get_content_strategy reads the brand's approved content plan: pillars, the next weeks and the counts (read only);
    # get_usage reads what the brand used this month against its limits, each number explained;
    # list_articles_due reads the brand's live articles due a refresh, with why (read only);
    # review_article starts or moves on a refresh review of one and says what it proposes (never applies);
    # get_setup_status/read_help_page answer "what should I set up first?"
    # and "how do I…?" from the brand's setup progress and the help pages;
    # new_person_propose fills in the New person form for an admin to confirm (never
    # consent); get_business_profile/read_onboarding_conversation read what the brand told Vizzy
    # about the business (facts, quotes and conversations for admins), and suggest_business_fact
    # files something new it heard for an admin to keep in About your business; get_work reads
    # the organisation's Work tasks and daily log (read only), and
    # suggest_work_task/draft_work_log/draft_work_decision suggest a task for Review and draft a
    # Log note or a decision a person saves (never Must have, never Approve the plan).
    # More marketing FunctionTools land alongside them.
    tools=[
        retrieve_knowledge,
        get_insights_summary,
        get_audience_counts,
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
        get_competitors,
        search_brand,
        get_email_results,
        get_post_results,
        list_connections,
        read_connected_live,
        get_connected_numbers,
        get_number_suggestions,
        get_brand_context,
        get_next_up,
        get_brand_strategy,
        get_content_strategy,
        get_usage,
        list_articles_due,
        review_article,
        get_setup_status,
        read_help_page,
        new_person_propose,
        get_business_profile,
        read_onboarding_conversation,
        suggest_business_fact,
        get_work,
        suggest_work_task,
        draft_work_log,
        draft_work_decision,
    ],
    # campaign_ops authors launch (waitlist) journeys; lifecycle_ops authors
    # connected-product lifecycle journeys. Both save drafts only.
    sub_agents=[campaign_ops_agent, lifecycle_ops_agent, content_ops_agent],
)
