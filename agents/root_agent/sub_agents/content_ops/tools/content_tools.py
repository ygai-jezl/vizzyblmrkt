"""Content Ops FunctionTools — thin ADK wrappers over content_client.

IMPORTANT (same as the other sub-agents' tools): ADK resolves the parameter
annotations at runtime to find and strip the injected `tool_context`, so
`ToolContext` must be a real runtime import and this module must NOT use
`from __future__ import annotations`. The pure logic lives in content_client.py.
"""

from typing import List, Optional

from google.adk.tools import ToolContext

from . import content_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_content_context(tool_context: ToolContext) -> dict:
    """List the brand's content programmes (the one on screen first), their templates
    and recent plans, and the values a plan's intake accepts. Call this before drafting.
    Where blog articles are written from a brand map, `brandMap` lists its subjects and
    their questions (with each one's state when `statesKnown` is true: answered, in
    progress or open), for a blog article's subject_id and question_id. A large map
    (`atAnySize`) lists only the open questions of the buying `situations` the brand
    focuses on, each question with its situationId.

    Returns:
        {"programmes": [...], "brandMap"?: {...}, "allowed": {"objectives", "hubChannels", "spokeChannels", "topics", ...}}
    """
    return client.get_context(_state(tool_context))


def draft_content_plan(
    name: str,
    objective: str,
    spark: str,
    tool_context: ToolContext,
    hub_channel: str = "newsletter",
    spoke_channels: Optional[List[str]] = None,
    topics: Optional[List[str]] = None,
    hub_url: str = "",
    sequence_type: str = "",
    workspace_id: str = "",
    primary_question: str = "",
    buyer_questions: str = "",
    subject_id: str = "",
    question_id: str = "",
    situation_id: str = "",
    hero_style: str = "",
) -> dict:
    """Draft a content plan in a programme and save it as a DRAFT.

    The server lays out the pieces (a hub plus promo and spoke posts, or an email
    sequence) and writes the hub (or the emails) in the brand voice. Nothing is
    approved, scheduled or published. Where it is switched on, a blog hub is
    researched first (the questions buyers ask, the brand's own pages to link to,
    third-party sources checked on the page), written as an answer-first article
    with its sources, and fact-checked; the result's message says what was done.

    Args:
        name: A short plan name.
        objective: One of the allowed objectives from get_content_context.
        spark: The operator's idea, in their words.
        hub_channel: "newsletter" or "blog".
        spoke_channels: Social channels to post on (allowed ids only).
        topics: Up to three allowed topic ids.
        hub_url: Only if the operator gave a link for people to land on.
        sequence_type: Only for the email_sequence objective.
        workspace_id: The programme. If empty, the programme on screen is used.
        primary_question: Blog hub only. The question the article answers, worded as a
            buyer would ask it. Leave empty and research finds it.
        buyer_questions: Blog hub only. Anything the operator said buyers ask, in
            their words. Leave empty if they said nothing.
        subject_id: Blog hub only, with a brandMap from get_content_context. The id of
            the subject the article is for, or "none" for none of them. Leave empty and
            research picks one.
        question_id: Blog hub only, with a brandMap. The id of the map question the
            article answers ("write this next"); set primary_question to its text too.
        situation_id: Blog hub only, with a brandMap that lists situations. The id of the
            buying situation the article is for (the article opens by meeting its reader
            there), or "none". Leave empty and research picks one.
        hero_style: Blog hub only, and only when the operator asked for a particular
            look for this article's hero image ("make the hero a photo"): one of
            product_noir, headline_card, illustration, editorial_photo, soft_3d, paper_collage, natural_photo, product_still_life or brand_character. It applies to this article only. Leave empty for the brand's
            style.

    Returns:
        A status dict to relay (includes a card the chat shows with an Open link).
    """
    intake = client.build_intake(
        name, objective, spark, hub_channel, spoke_channels, topics, hub_url, sequence_type,
        primary_question, buyer_questions, subject_id, question_id, situation_id,
    )
    return client.draft_plan(_state(tool_context), workspace_id, intake, spark, hero_style)


def get_content_plan(tool_context: ToolContext, plan_id: str = "", workspace_id: str = "") -> dict:
    """Read a plan's pieces (ids, types, statuses and copy) before rewriting any.

    Args:
        plan_id: The plan. If empty, the plan on screen is used.
        workspace_id: Its programme. If empty, the programme on screen is used.
    """
    return client.get_plan(_state(tool_context), workspace_id, plan_id)


def rewrite_content_nodes(
    node_ids: List[str],
    instructions: str,
    tool_context: ToolContext,
    plan_id: str = "",
    workspace_id: str = "",
) -> dict:
    """Rewrite chosen pieces of a plan from the operator's instruction (a DRAFT change).

    Pieces a person approved or scheduled can't be changed, and social pieces wait
    until the hub is approved; the tool says which, so you can tell the operator.

    Args:
        node_ids: The piece ids, from get_content_plan.
        instructions: What to change, in the operator's words.
        plan_id: The plan. If empty, the plan on screen is used.
        workspace_id: Its programme. If empty, the programme on screen is used.
    """
    return client.rewrite_nodes(_state(tool_context), workspace_id, plan_id, node_ids, instructions)
