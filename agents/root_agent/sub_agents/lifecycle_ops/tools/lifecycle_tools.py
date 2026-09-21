"""Lifecycle Ops FunctionTools — thin ADK wrappers over lifecycle_client.

IMPORTANT (same as campaign_ops/tools/build_journey.py): ADK builds each tool's
function declaration by RESOLVING the parameter annotations at runtime to find
and strip the injected `tool_context`. So `ToolContext` must be a real runtime
import, and this module must NOT use `from __future__ import annotations`.
The pure logic lives in lifecycle_client.py so it stays unit-testable without ADK.
"""

from typing import Optional

from google.adk.tools import ToolContext

from . import lifecycle_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_lifecycle_context(tool_context: ToolContext) -> dict:
    """Read what you need to plan a lifecycle journey for this account.

    Returns the connected products (each with its catalog: events, traits,
    onboarding steps with deep links, and glossary), AGGREGATE onboarding stats
    (how many users, the share completing each step, median hours to each step),
    the existing lifecycle journeys, the verified sending domains and workspaces.
    It never returns individual people or email addresses. Call this first.
    """
    return client.get_context(_state(tool_context))


def draft_lifecycle_journey(
    connection_id: str,
    brief: str,
    tool_context: ToolContext,
    template: str = "product_onboarding",
    options: Optional[dict] = None,
    name: Optional[str] = None,
    journey_id: Optional[str] = None,
) -> dict:
    """Build a lifecycle journey from a template and save it as a DRAFT.

    The main way to create a journey. The server builds the whole structure from
    the product's catalog (so it is always valid) and writes on-brand copy for
    every email. Use the `product_onboarding` template for any post-signup
    onboarding sequence: it welcomes the person, then on each step checks whether
    onboarding is complete — nudging people who aren't towards their exact next
    step, and educating people who are.

    Args:
        connection_id: The connected product (from get_lifecycle_context). If
            empty, the product of the page the operator is on is used.
        brief: The operator's words about tone and emphasis, passed to the copywriter.
        template: "product_onboarding".
        options: Optional. {"days": 5|7|10|14, "sendDays": [0-6 weekdays, 0=Sunday],
            "sendTime": "HH:MM", "windowMinutes": 15-240, "reminders": 1-3,
            "education": 1-3, "sender": {"fromName", "fromEmail", "replyTo"},
            "categoryLabel": "Onboarding tips"}. Leave out anything not asked for.
        name: Optional journey name.
        journey_id: Only to REBUILD an existing journey's draft from the template.

    Returns:
        A status dict to relay (includes a card the chat shows with an Open canvas link).
    """
    return client.draft_journey(_state(tool_context), connection_id, template, options, brief, name, journey_id)


def get_lifecycle_journey(journey_id: str, tool_context: ToolContext) -> dict:
    """Read a lifecycle journey's current DRAFT (graph, content pools, settings) and its issues.

    Use before editing a journey, so you change what is actually there. If
    journey_id is empty, the journey of the page the operator is on is used.
    """
    return client.get_journey(_state(tool_context), journey_id)


def save_lifecycle_graph(
    connection_id: str,
    graph: dict,
    brief: str,
    tool_context: ToolContext,
    journey_id: Optional[str] = None,
    pools: Optional[list] = None,
    settings: Optional[dict] = None,
    name: Optional[str] = None,
) -> dict:
    """Save a whole lifecycle journey draft you edited (or a custom structure).

    For edits: call get_lifecycle_journey, change what the operator asked for,
    and pass back the FULL graph, pools and settings. If the result has issues,
    fix them and save again (at most twice). This only ever changes the DRAFT —
    the published version is untouched until a human publishes.

    Args:
        connection_id: The connected product (empty = the page's product).
        graph: {"nodes": [...], "edges": [...]} — see your instruction for the shape.
        brief: What you changed, in a sentence.
        journey_id: The journey to edit (empty = the page's journey, or a new one).
        pools: The content pools (omit to keep the journey's current pools).
        settings: The settings (omit to keep the journey's current settings).
        name: Optional new name (new journeys only).

    Returns:
        A status dict to relay, with any issues to fix.
    """
    return client.save_graph(_state(tool_context), connection_id, journey_id, graph, pools, settings, brief, name)
