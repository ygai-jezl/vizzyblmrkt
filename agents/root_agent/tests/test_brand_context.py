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


def test_blank_or_odd_page_adds_nothing():
    assert build_dynamic_instruction(_ctx({"page": "   "})) == ROOT_SYSTEM_INSTRUCTION
    assert build_dynamic_instruction(_ctx({"page": 42})) == ROOT_SYSTEM_INSTRUCTION
