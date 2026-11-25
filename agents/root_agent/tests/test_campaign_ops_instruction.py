"""Unit tests for the Campaign Ops dynamic instruction (pure helper, no ADK needed)."""

from __future__ import annotations

import types

from root_agent_pkg.sub_agents.campaign_ops.instruction_builder import (
    build_campaign_ops_instruction,
)
from root_agent_pkg.sub_agents.campaign_ops.prompts.instruction import (
    CAMPAIGN_OPS_INSTRUCTION,
)


def _ctx(state):
    return types.SimpleNamespace(state=state)


def test_no_locale_or_english_returns_base():
    assert build_campaign_ops_instruction(_ctx({})) == CAMPAIGN_OPS_INSTRUCTION
    assert build_campaign_ops_instruction(_ctx(None)) == CAMPAIGN_OPS_INSTRUCTION
    assert build_campaign_ops_instruction(_ctx({"locale": "en"})) == CAMPAIGN_OPS_INSTRUCTION


def test_non_english_prepends_directive():
    out = build_campaign_ops_instruction(_ctx({"locale": "de"}))
    assert out.startswith("RESPOND IN German")
    assert CAMPAIGN_OPS_INSTRUCTION in out


def test_instruction_documents_condition_catalog_and_default_edge():
    """Regression: the dead-end incident came from the model inventing condition
    field keys and omitting the default edge. The instruction must teach the real
    catalog keys + the mandatory default edge so it generates valid graphs."""
    text = CAMPAIGN_OPS_INSTRUCTION
    for key in ("usedVoiceChat", "referralCount", "madeReferral", "surveyAnswer"):
        assert key in text, f"instruction should document the {key} field"
    # must instruct wiring a default else-edge so conditions never dead-end
    assert "sourceHandle" in text
    assert "default" in text
    # names the invented keys as an explicit anti-example (don't use these)
    assert "usedVoiceChat" in text and "never invent" in text.lower()


def test_appends_what_the_brand_told_vizzy_when_the_root_has_it_cached():
    import types as _types

    from root_agent_pkg.context import business_profile as _bpc
    from root_agent_pkg.sub_agents.campaign_ops.instruction_builder import build_campaign_ops_instruction as _build
    from root_agent_pkg.sub_agents.campaign_ops.prompts.instruction import CAMPAIGN_OPS_INSTRUCTION as _base

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
