"""`build_email_journey` FunctionTool — a thin ADK wrapper over canvas_client.

IMPORTANT (do not "tidy" this back into TYPE_CHECKING):
ADK builds this tool's function declaration by RESOLVING the parameter annotations
at runtime to recognize and strip the injected `tool_context`. So `ToolContext`
must be a real runtime import, and this module must NOT use
`from __future__ import annotations` (PEP 563 would turn the annotations into
strings that ADK then fails to resolve → NameError in build_function_declaration,
crashing the agent turn). The pure, ADK-free logic lives in canvas_client.py so
it stays unit-testable without ADK.
"""

from google.adk.tools import ToolContext

from .canvas_client import author_journey_via_canvas


def build_email_journey(
    campaign_id: str,
    brief: str,
    graph: dict,
    tool_context: ToolContext,
) -> dict:
    """Save a multi-step email journey as a DRAFT for the operator to review.

    Use this when the operator asks you to build, set up, or design an email
    journey / sign-up sequence / welcome series / onboarding drip for a launch.
    Assemble the graph yourself (trigger -> email -> wait -> email -> ...) and pass
    it as `graph`; leave each email node's `subject` and `body` EMPTY — on-brand
    copy is written for you when the draft is saved. This saves a DRAFT only; it
    never sends and never activates. After it returns, tell the operator to review
    and Activate on the Journey Canvas.

    Args:
        campaign_id: The launch/campaign id to attach the journey to. If empty,
            the active launch from the session is used.
        brief: A short natural-language description of the sequence to build.
        graph: The journey graph: {"nodes": [...], "edges": [...]}. Each node has
            `id`, `type` ("trigger"|"email"|"wait"|"condition"), `position`
            {"x":.., "y":..}, and `data` (email: `label`; wait: `waitHours`;
            condition: `branches`). Leave email `subject`/`body` empty.

    Returns:
        A status dict to relay to the operator.
    """
    state = getattr(tool_context, "state", None) or {}
    return author_journey_via_canvas(state, campaign_id, brief, graph)
