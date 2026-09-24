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

    Returns:
        {"programmes": [...], "allowed": {"objectives", "hubChannels", "spokeChannels", "topics", ...}}
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
) -> dict:
    """Draft a content plan in a programme and save it as a DRAFT.

    The server lays out the pieces (a hub plus promo and spoke posts, or an email
    sequence) and writes the hub (or the emails) in the brand voice. Nothing is
    approved, scheduled or published.

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

    Returns:
        A status dict to relay (includes a card the chat shows with an Open link).
    """
    intake = client.build_intake(name, objective, spark, hub_channel, spoke_channels, topics, hub_url, sequence_type)
    return client.draft_plan(_state(tool_context), workspace_id, intake, spark)


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
