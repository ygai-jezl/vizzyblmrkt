"""Unit tests for the Content Ops instruction (pure helper, no ADK needed)."""

from __future__ import annotations

import types

from root_agent_pkg.sub_agents.content_ops.instruction_builder import build_content_ops_instruction
from root_agent_pkg.sub_agents.content_ops.prompts.instruction import CONTENT_OPS_INSTRUCTION
from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION


def _ctx(state):
    return types.SimpleNamespace(state=state)


def test_base_instruction_for_english():
    assert build_content_ops_instruction(_ctx({})) == CONTENT_OPS_INSTRUCTION


def test_names_the_programme_and_plan_in_view():
    out = build_content_ops_instruction(_ctx({"workspaceId": "ws1", "planId": "p1"}))
    assert "programme ws1" in out and "plan p1" in out and "get_content_plan" in out


def test_drafts_only_and_allowed_values_only():
    text = " ".join(CONTENT_OPS_INSTRUCTION.lower().split())  # ignore line wrapping
    assert "drafts only" in text
    assert "never say anything was published, scheduled or sent" in text
    assert "use only what it returns" in text
    assert "get_content_context" in CONTENT_OPS_INSTRUCTION


def test_never_claims_research_or_a_fact_check_the_tool_did_not_report():
    text = " ".join(CONTENT_OPS_INSTRUCTION.lower().split())
    # Blog research is flag-gated on the server: Vizzy repeats the tool's message, not a promise.
    assert "the tool's message says what was done" in text
    assert "never tell the operator an article was researched, sourced or fact-checked unless the message says so" in text


def test_root_routes_content_to_content_ops():
    assert "content_ops_agent" in ROOT_SYSTEM_INSTRUCTION


def test_appends_what_the_brand_told_vizzy_when_the_root_has_it_cached():
    import types as _types

    from root_agent_pkg.context import business_profile as _bpc
    from root_agent_pkg.sub_agents.content_ops.instruction_builder import build_content_ops_instruction as _build
    from root_agent_pkg.sub_agents.content_ops.prompts.instruction import CONTENT_OPS_INSTRUCTION as _base

    _bpc.cache_clear()
    state = {"tenantId": "ten_A", "userId": "usr_1", "profileRev": "3"}
    # Nothing cached (a new replica, or no profile): exactly as before.
    assert _build(_types.SimpleNamespace(state=state)) == _build(_types.SimpleNamespace(state={})) == _base
    _bpc.cache_put("ten_A", "usr_1", "3", "## About this business\n<yg_business_profile>\nWhat you run: A shop or products\n</yg_business_profile>")
    try:
        out = _build(_types.SimpleNamespace(state=state))
        assert out.startswith(_base)
        assert out.endswith("</yg_business_profile>")
        # Another person's, or an older rev's, is never used.
        assert _build(_types.SimpleNamespace(state={**state, "userId": "usr_2"})) == _base
    finally:
        _bpc.cache_clear()
