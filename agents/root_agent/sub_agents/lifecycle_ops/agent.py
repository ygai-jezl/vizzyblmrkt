"""Lifecycle Ops Agent — Vizzy's specialist for connected-product lifecycle journeys.

It builds and edits LIFECYCLE JOURNEYS (e.g. a post-signup onboarding sequence that
splits on each user's progress) and saves them as DRAFTS for human review. The
root agent (Vizzy) delegates to it for anything about a client's own product users,
onboarding or lifecycle email.

Its tools call back into the Next.js app with the signed capability token: read
the account's products/catalogs (aggregates only — never people), read a journey's
draft, and save drafts through the canvas endpoint. Publishing, delivery mode and
AI-line approvals stay human-only, so no tool confirmation is needed here.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from .instruction_builder import build_lifecycle_ops_instruction
from .tools.lifecycle_tools import (
    draft_lifecycle_journey,
    get_lifecycle_context,
    get_lifecycle_journey,
    get_repo_analysis,
    learn_product_from_repo,
    save_lifecycle_graph,
)
from ...model_config import DEFAULT_MODEL

lifecycle_ops_agent = LlmAgent(
    name="lifecycle_ops_agent",
    model=DEFAULT_MODEL,
    description=(
        "Lifecycle Ops Agent: builds and edits lifecycle journeys for a client's "
        "CONNECTED PRODUCT users — post-signup onboarding sequences that nudge people "
        "who haven't finished onboarding and educate people who have — and saves them "
        "as drafts for human review. Delegate here for anything about product users, "
        "onboarding progress, lifecycle email or a journey page under Lifecycle."
    ),
    instruction=build_lifecycle_ops_instruction,
    tools=[
        get_lifecycle_context,
        draft_lifecycle_journey,
        get_lifecycle_journey,
        save_lifecycle_graph,
        learn_product_from_repo,
        get_repo_analysis,
    ],
)
