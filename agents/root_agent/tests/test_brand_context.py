"""Unit tests for build_dynamic_instruction: language directive + brand layering.

Pure — brand_context keeps its ADK import under TYPE_CHECKING, so no ADK needed.
"""

from __future__ import annotations

import types

from root_agent_pkg.context.brand_context import build_dynamic_instruction
from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION


def _ctx(state):
    return types.SimpleNamespace(state=state)


def test_no_state_returns_base_unchanged():
    assert build_dynamic_instruction(_ctx({})) == ROOT_SYSTEM_INSTRUCTION
    assert build_dynamic_instruction(_ctx(None)) == ROOT_SYSTEM_INSTRUCTION


def test_english_locale_adds_no_directive():
    assert build_dynamic_instruction(_ctx({"locale": "en"})) == ROOT_SYSTEM_INSTRUCTION


def test_non_english_locale_prepends_directive():
    out = build_dynamic_instruction(_ctx({"locale": "fr"}))
    assert out.startswith("RESPOND IN French")
    assert ROOT_SYSTEM_INSTRUCTION in out


def test_locale_and_brand_block_compose():
    state = {
        "locale": "ja",
        "brandSettings": {"brandName": "Acme", "primaryDomain": "acme.com"},
    }
    out = build_dynamic_instruction(_ctx(state))
    assert "RESPOND IN Japanese" in out
    assert "## Current Brand Context" in out
    assert "Acme" in out


def test_page_context_is_appended():
    out = build_dynamic_instruction(_ctx({"page": "Launches › Fernlight Beta › Signups"}))
    assert out.startswith(ROOT_SYSTEM_INSTRUCTION)
    assert out.endswith(
        "They are looking at this page of the YouGrow admin: Launches › Fernlight Beta › Signups. "
        'When they say "this" or "here", assume they mean what is on that page.'
    )


def test_a_page_named_with_ideas_reaches_vizzy_with_the_glossary():
    # With piece D's words on, the crumbs (and so the page name) say Ideas; the glossary says it's a launch.
    out = build_dynamic_instruction(_ctx({"page": "Ideas › Team spaces › Overview"}))
    assert "They are looking at this page of the YouGrow admin: Ideas › Team spaces › Overview. " in out
    assert "The app may call a launch an idea; same thing, same id." in out


def test_blank_or_odd_page_adds_nothing():
    assert build_dynamic_instruction(_ctx({"page": "   "})) == ROOT_SYSTEM_INSTRUCTION
    assert build_dynamic_instruction(_ctx({"page": 42})) == ROOT_SYSTEM_INSTRUCTION


def test_a_persons_page_hands_this_person_to_lifecycle_ops():
    from root_agent_pkg.context.brand_context import PERSON_IN_VIEW_BLOCK

    page = "Audience › Product users › Person"
    out = build_dynamic_instruction(_ctx({"page": page, "personId": "pu_3f9a"}))
    assert out.endswith(PERSON_IN_VIEW_BLOCK)
    assert "lifecycle_ops_agent" in PERSON_IN_VIEW_BLOCK
    assert "don't ask for a name or an email address" in PERSON_IN_VIEW_BLOCK
    # Any person, not only a product user, and their fields go the same way.
    assert "one person's" in PERSON_IN_VIEW_BLOCK and "product user" not in PERSON_IN_VIEW_BLOCK
    assert "their fields" in PERSON_IN_VIEW_BLOCK and "a change to suggest" in PERSON_IN_VIEW_BLOCK
    # Our id for them is the tools' business, not the prompt's.
    assert "pu_3f9a" not in out
    # No person in view (the app sends "" off their page): nothing added.
    for state in ({"page": page}, {"page": page, "personId": ""}):
        assert PERSON_IN_VIEW_BLOCK not in build_dynamic_instruction(_ctx(state))


def test_a_decks_page_hands_this_deck_and_this_slide_to_raise_ops():
    from root_agent_pkg.context.brand_context import DECK_IN_VIEW_BLOCK

    page = "Content › Raise kit › Deck"
    out = build_dynamic_instruction(_ctx({"page": page, "raiseDocId": "rd_abcdefghij12"}))
    assert out.endswith(DECK_IN_VIEW_BLOCK)
    assert "raise_ops_agent" in DECK_IN_VIEW_BLOCK and "not Content Ops" in DECK_IN_VIEW_BLOCK
    # The studio's foot ask sends "On slide {n}: ...", with no word for deck in it.
    assert "On slide 4:" in DECK_IN_VIEW_BLOCK
    # The deck's id is the tools' business, not the prompt's.
    assert "rd_abcdefghij12" not in out
    # No deck in view ("" once the operator leaves) or anything that isn't a deck id: nothing added.
    for state in ({"page": page}, {"page": page, "raiseDocId": ""}, {"page": page, "raiseDocId": "rd_../x"}):
        assert DECK_IN_VIEW_BLOCK not in build_dynamic_instruction(_ctx(state))
