"""`get_setup_status` and `read_help_page` FunctionTools: Vizzy answers "What should
I set up first?" and "How do I…?" from the brand's real progress and the help pages.

IMPORTANT (same as insights_summary.py): ADK resolves the parameter annotations at
runtime to find and strip the injected `tool_context`, so `ToolContext` must be a
real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in setup_help_client.py.
"""

from google.adk.tools import ToolContext

from .setup_help_client import get_help_page, get_status


def get_setup_status(tool_context: ToolContext) -> dict:
    """Get where the brand is on its setup: five stages in order (Get ready, Launch,
    Grow audience, Launch product, Onboard & retain), each step done or not, what a
    step needs first (`needsFirst`), a warning where the order matters, the app page
    to do it (`appLink`) and the help page that explains it (`howTo`). Also
    `currentStage`, `nextStep` and the list of `helpPages`.

    Call this FIRST for "what should I set up first?", "what's next?", "am I set
    up?", "why can't I…?" or any question about getting started. Answer with the
    `nextStep` and why, in a sentence or two, give its `appLink` and `howTo`, and
    pass on its `warning` when there is one. Never say a step is done unless it is.

    Returns:
        {"status": "success", "currentStage": {...} or null, "nextStep": {...} or
         null, "stages": [...], "helpPages": [...]}, or a status dict to relay.
    """
    state = getattr(tool_context, "state", None) or {}
    return get_status(state)


def read_help_page(page: str, tool_context: ToolContext) -> dict:
    """Read one of YouGrow's help pages as Markdown, to answer "how do I…?" questions
    with the exact steps, labels and fixes.

    Args:
        page: the page name, one of: get-set-up, email-sending, your-brand,
            email-style, launch-and-waitlist, programmes-and-knowledge, brand-map,
            write-and-schedule, connected-accounts, connect-your-product,
            invite-your-waitlist, onboarding-journeys, review-and-approvals,
            people, troubleshooting.

    Answer from the page, briefly, and link its `url` for the full steps. For
    something that isn't working, read "troubleshooting".

    Returns:
        {"status": "success", "title": ..., "url": ..., "markdown": ...}, or a
        status dict to relay.
    """
    state = getattr(tool_context, "state", None) or {}
    return get_help_page(state, page)
