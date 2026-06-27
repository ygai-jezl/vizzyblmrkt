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
