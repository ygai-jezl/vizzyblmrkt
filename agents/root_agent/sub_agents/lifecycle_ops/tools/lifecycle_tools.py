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
from . import people_fields_client as fields_client


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
    template: str = "",
    options: Optional[dict] = None,
    name: Optional[str] = None,
    journey_id: Optional[str] = None,
    after_journey_id: Optional[str] = None,
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
        template: Leave empty for the usual one: "product_onboarding", or "follow_on"
            when after_journey_id is given (the sequence that comes after that journey).
        options: Optional. {"days": 5|7|10|14, "sendDays": [0-6 weekdays, 0=Sunday],
            "sendTime": "HH:MM", "windowMinutes": 15-240, "reminders": 1-3,
            "education": 1-3, "sender": {"fromName", "fromEmail", "replyTo"},
            "categoryLabel": "Onboarding tips"}. For "follow_on": {"emails": 1-6,
            "gapDays": 1-14} instead of days/reminders/education. Leave out anything
            not asked for.
        name: Optional journey name.
        journey_id: Only to REBUILD an existing journey's draft from the template.
        after_journey_id: The id of the journey this one CONTINUES FROM (from
            get_lifecycle_context), when your instruction says journeys can continue
            from one another. People then enter when they finish that journey, and
            every wait counts from that moment.

    Returns:
        A status dict to relay (includes a card the chat shows with an Open canvas link).
    """
    return client.draft_journey(_state(tool_context), connection_id, template, options, brief, name, journey_id, after_journey_id)


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
    after_journey_id: Optional[str] = None,
    new_journey: bool = False,
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
        after_journey_id: Make the journey CONTINUE FROM this journey (it starts when
            someone finishes that one), when your instruction says journeys can
            continue from one another. Omit to leave how it starts as it is.
        new_journey: True to save this as a NEW journey, whatever page the operator is
            on. Without it an empty journey_id means the journey of that page, whose
            draft would be replaced. Pass pools, settings and a name with it.

    Returns:
        A status dict to relay, with any issues to fix.
    """
    return client.save_graph(
        _state(tool_context), connection_id, journey_id, graph, pools, settings, brief, name, after_journey_id, new_journey
    )


def learn_product_from_repo(
    tool_context: ToolContext,
    repos: Optional[list] = None,
    connection_id: str = "",
    branch: Optional[str] = None,
) -> dict:
    """Start a READ-ONLY analysis of the product's code to propose its catalog.

    Reads the connected GitHub/GitLab repositories (we never change them) and
    proposes the product's onboarding steps and how each is done, the events it
    can send, traits, facts and glossary — each backed by code. It runs in the
    background for a few minutes. It does NOT change the catalog: a person reviews
    the results and chooses what to keep on the product's "Learn from repo" tab.

    Args:
        repos: Up to 3 repository URLs, e.g. ["github.com/acme/web"] (or
            [{"url": ..., "ref": "main"}]). Ask the operator if you don't know them.
        connection_id: The connected product. If empty, the product of the page
            the operator is on is used.
        branch: Optional branch for every repo (default branch otherwise).
    """
    return client.learn_from_repo(_state(tool_context), connection_id, repos, branch)


def get_repo_analysis(tool_context: ToolContext, connection_id: str = "") -> dict:
    """Check the latest repo analysis for a product: its status and what it found.

    Returns the proposed onboarding steps (with how each completes and whether it
    can be detected on the server), events, traits, facts, glossary, the
    integration hooks and gaps found in the code, and whether each item is backed
    by verified code. No code is included. Point the operator to `reviewUrl` to
    review and accept items — you can't accept them yourself.
    """
    return client.get_repo_analysis(_state(tool_context), connection_id)


def get_person_brief(tool_context: ToolContext, product_user_id: str = "") -> dict:
    """Read ONE product user's situation, to explain what happened or plan what they get next.

    Returns a brief of that person: the stage they're at (onboarding steps done, the
    step they're on and for how long, whether they've gone quiet), whether they can be
    emailed and why not, their onboarding checklist, what they have (brands,
    workspaces…) and the facts the product reports, each journey they're in — what
    was sent, whether each email was opened or clicked (null = it wasn't tracked),
    what is held and why, and the emails ahead with their dates — and how many AI
    lines are waiting in Approvals.

    It never contains their name, their email address or the product's id for them,
    and you must not ask for any of those. Call them "this person" or "they".

    Args:
        product_user_id: Leave empty for the person whose page the operator is on. Only
            pass the `productUserId` a brief gave you earlier.
    """
    return client.get_person(_state(tool_context), product_user_id)


def save_person_plan(
    goal: str,
    angle: str,
    tool_context: ToolContext,
    next_steps: Optional[list] = None,
    review_in_days: Optional[int] = None,
    product_user_id: str = "",
) -> dict:
    """Save a DRAFT plan for ONE product user: what to help them do next, and how to put it.

    Call get_person_brief first, and write the plan from what it shows. The plan is a
    draft: someone on the operator's team approves it on the person's page, and only
    then does it shape that person's personalised line (which still goes through
    Approvals). It sends nothing and changes no journey.

    Never put the person's name or an email address in any of it — say "they". A plan
    that names them is refused.

    Args:
        goal: The one thing you want them to do next, in a few words
            ("Connect their site").
        angle: How to put it to them, in a sentence or two: what to lead with, the
            tone, what to leave out. Based on what they did (opened, clicked, ignored).
        next_steps: Up to 6 short steps for the team, in order (e.g. "Send the next
            reminder with this angle", "If still stuck in a week, add them to <journey>").
        review_in_days: When to look at them again, in days from today (1-90).
        product_user_id: Leave empty for the person whose page the operator is on.

    Returns:
        A status dict to relay (with a card the chat shows, linking to their page).
    """
    return client.save_person_plan(_state(tool_context), goal, angle, next_steps, review_in_days, product_user_id)



def people_fields_list(tool_context: ToolContext) -> dict:
    """List the brand's own People fields you can read and suggest, with their options.

    Only select, multi select, status, checkbox, number, currency and date fields, and
    text fields the brand lets you read, the ones in use: never other text fields, or
    email, phone, link or team member fields. No values. Each has an id, a label, a
    type, its options (each with an id) and, for currency, its code. The note says how
    each type's value is written.
    """
    return fields_client.list_fields(_state(tool_context))


def person_fields_read(tool_context: ToolContext, person_id: str = "") -> dict:
    """Read ONE person's values of the fields you can see, to answer about them or suggest a change.

    Returns each field with its value (null when unset) and the value in words, and
    `waiting`: the fields that already have a suggestion for someone to confirm. It
    never holds their name, their email address or an email, phone, link or team member
    value. A text value, only for a field the brand lets you read, has their name and
    address taken out ([name], [email], [id]) and is at most 500 characters, with
    "cut": true when it was longer. Works for anyone in the list of people, including
    people who only joined a launch or were added by hand.

    Args:
        person_id: Leave empty for the person whose page the operator is on.
    """
    return fields_client.read_person(_state(tool_context), person_id)


def person_fields_propose(changes: dict, why: str, tool_context: ToolContext, person_id: str = "") -> dict:
    """Suggest changes to ONE person's fields, for someone on the operator's team to confirm.

    Call person_fields_read first. Nothing changes until an admin confirms it on the
    person's page or in Review. A suggestion for a field that already has one waiting
    replaces it. Never use it to record consent.

    Args:
        changes: Field id to the suggested value, written as the fields read says
            (an option id, a list of option ids, true or false, a number, whole minor
            units for currency, a day as YYYY-MM-DD, or plain text of at most 500
            characters with no [name], [email] or [id] in it). null clears a value.
            A text value the read marked "cut" can only be cleared with null.
        why: One sentence on what you saw that supports it. No name or email address.
        person_id: Leave empty for the person whose page the operator is on.

    Returns:
        A status dict to relay (with a card the chat shows, linking to their page).
    """
    return fields_client.propose(_state(tool_context), changes, why, person_id)
