"""Content Ops Agent — Vizzy's specialist for content programmes (nav v2 phase 4).

It drafts CONTENT PLANS (a hub with promo and spoke posts, or an email sequence)
in a brand's programmes and rewrites pieces on request, saving DRAFTS only. The
root agent (Vizzy) delegates to it for posts, newsletters and content plans.

Its tools call back into the Next.js app with the signed capability token: read
the brand's programmes (brand content only, never people) and save drafts through
the canvas endpoint. Approving, scheduling and publishing stay human-only, so no
tool confirmation is needed here.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from .instruction_builder import build_content_ops_instruction
from .tools.content_tools import (
    draft_content_plan,
    get_content_context,
    get_content_plan,
    rewrite_content_nodes,
)
from ...model_config import DEFAULT_MODEL

content_ops_agent = LlmAgent(
    name="content_ops_agent",
    model=DEFAULT_MODEL,
    description=(
        "Content Ops Agent: drafts content plans in the brand's content programmes — "
        "a newsletter or blog hub with social posts, or an email sequence — and rewrites "
        "pieces on request, saving drafts for human review. Delegate here for planning "
        "posts, newsletters or a programme's content."
    ),
    instruction=build_content_ops_instruction,
    tools=[get_content_context, draft_content_plan, get_content_plan, rewrite_content_nodes],
)
