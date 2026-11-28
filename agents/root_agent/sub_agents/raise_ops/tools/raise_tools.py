"""Raise Ops FunctionTools: thin ADK wrappers over raise_client.

IMPORTANT (same as the other sub-agents' tools): ADK resolves the parameter annotations at runtime
to find and strip the injected `tool_context`, so `ToolContext` must be a real runtime import and
this module must NOT use `from __future__ import annotations`. The pure logic lives in
raise_client.py.
"""

from google.adk.tools import ToolContext

from . import raise_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def draft_raise_doc(audience: str, tool_context: ToolContext, stage: str = "", title: str = "", brief: str = "") -> dict:
    """Draft a new deck and save it as version 1, a DRAFT a person reviews on Content › Raise kit.

    The server reads what YouGrow knows about the brand (its website, repo, brand map, strategy,
    competitors, team list and numbers) and writes every slide with its speaker notes. Every number
    is filled by the server with where it came from; anything it can't see shows as a Needs on its
    slide. Nothing is sent or shared.

    Args:
        audience: "investor" for a deck to raise money by selling shares, or "lender" for a pack
            for a bank or other lender, such as a loan for new stock.
        stage: Investor decks only: "pre_seed" (10 slides, the default) or "seed" (12 slides).
        title: A short name for the deck, only if the operator gave one.
        brief: The operator's own words about the raise: what the money is for, who it's for.

    Returns:
        {"status": "success", "docId", "version", "url", "card", "warnings", "message"} to relay,
        or an error with a plain message.
    """
    return client.draft(_state(tool_context), audience, stage, title, brief)


def get_raise_doc(tool_context: ToolContext, doc_id: str = "") -> dict:
    """Read a deck before changing it: each slide by number with its words, numbers (each with its
    label and date), speaker notes, Needs and checks, the talk time, and its versions. Read only.

    With no doc_id it reads the deck on screen, else the brand's only deck, or lists the decks when
    there are several. `numbers` says which of YouGrow's numbers can go on a slide, and
    `meanings` what each number means.

    Args:
        doc_id: The deck's id (rd_...). Leave empty for the deck on screen.
    """
    return client.get(_state(tool_context), doc_id)


def revise_raise_doc(
    change: str,
    tool_context: ToolContext,
    slide: int = 0,
    after: int = 0,
    to: int = 0,
    ask: str = "",
    section: str = "",
    layout: str = "",
    meaning: str = "",
    weeks: int = 0,
    launch: str = "",
    name: str = "",
    value: float = 0,
    unit: str = "",
    currency: str = "",
    per: str = "",
    source_note: str = "",
    quote: str = "",
    note: str = "",
    version: int = 0,
    doc_id: str = "",
) -> dict:
    """Make ONE change to a deck and save it as a new draft version. Read the deck with
    get_raise_doc first and pass the version you read; slides are named by their number in it.

    Args:
        change: One of "rewrite" (a slide's words, as `ask` says), "notes" (its speaker notes
            again, as `ask` says), "add" (a new slide of `section` after slide `after`, 0 for the
            start, with an optional `layout` and `ask`), "remove", "move" (to place `to`),
            "layout", "number" (one of YouGrow's numbers), "typed_number" (a number the person
            said in this chat) or "refresh_numbers" (YouGrow's numbers again, as of now).
        slide: The slide's number in the version read.
        after: "add" only: the slide the new one follows (0 = first).
        to: "move" only: the slide's new place.
        ask: "rewrite", "notes" or "add": what the person wants, in their words.
        section: "add" only: cover, problem, solution, product, traction, why_now, market,
            competition, business_model, go_to_market, team, ask, sales, use_of_funds or repayment.
        layout: "layout" (or "add"): cover, statement, three_points, big_number, chart, compare,
            team or ask.
        meaning: "number" only: waitlistSignups, signupGrowth or launchSignups.
        weeks: "number" only: 4, 8 or 12 weeks of sign-ups (12 when left out).
        launch: "number" with launchSignups: the launch's name as get_raise_doc lists it.
        name: "typed_number" only: what the number is, such as "Monthly sales".
        value: "typed_number" only: the number exactly as the person said it.
        unit: "typed_number" only: "count", "money" or "percent".
        currency: "typed_number" money only: GBP, USD or EUR.
        per: "typed_number" only: "month" or "year", when it's per month or year.
        source_note: "typed_number" only: where the number is from, such as "our till".
        quote: "typed_number" only: the person's exact words that hold the number.
        note: A short change note for the version, such as "Led slide 5 with the weekly growth."
        version: The version you read with get_raise_doc. Needed for every change except
            "refresh_numbers".
        doc_id: The deck's id. Leave empty for the deck on screen, else the newest.

    Returns:
        The same as draft_raise_doc, with the new version.
    """
    op = client.build_op(change, slide, after, to, ask, section, layout, meaning, weeks, launch, name, value, unit, currency, per, source_note, quote)
    return client.revise(_state(tool_context), op, note, version, doc_id)
