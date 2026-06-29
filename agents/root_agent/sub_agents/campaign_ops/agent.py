"""Campaign Ops Agent — Vizzy's email-operations specialist (ADK 2.x sub-agent).

It programs email campaigns natively in the platform; its current skill is
authoring multi-step EMAIL JOURNEYS on the Journey Canvas and saving them as
DRAFTS for human review. The root agent (Vizzy) delegates to it.

It exposes one tool, `build_email_journey`, which calls back into the Next.js app
(the canvas endpoint) to fill copy via the Creative Director, validate, and
persist a draft. It NEVER activates a journey — the operator activates from the
canvas. Saving a draft is low-impact, so no tool confirmation is needed (a future
activate capability is where ADK `require_confirmation` would belong).
"""

from __future__ import annotations

import os

from google.adk.agents import LlmAgent

from .instruction_builder import build_campaign_ops_instruction
from .tools.build_journey import build_email_journey
from ...tools.retrieve_knowledge import retrieve_knowledge

campaign_ops_agent = LlmAgent(
    name="campaign_ops_agent",
    model=os.environ.get("ROOT_AGENT_MODEL", "gemini-3.5-flash"),
    description=(
        "Campaign Ops Agent: authors multi-step email journeys on the Journey "
        "Canvas and saves them as drafts for human review. Delegate here when the "
        "operator wants to build, set up, or design an email journey / sign-up "
        "sequence / welcome series / onboarding drip for a launch."
    ),
    # Callable instruction: prepends the operator language directive each turn.
    instruction=build_campaign_ops_instruction,
    # retrieve_knowledge grounds copy on the launch's ingested docs/site/repos
    # before authoring; build_email_journey persists the draft.
    tools=[build_email_journey, retrieve_knowledge],
)
