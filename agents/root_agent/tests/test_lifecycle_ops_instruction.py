"""Unit tests for the Lifecycle Ops instruction (pure helper, no ADK needed)."""

from __future__ import annotations

import types

from root_agent_pkg.sub_agents.lifecycle_ops.instruction_builder import build_lifecycle_ops_instruction
from root_agent_pkg.sub_agents.lifecycle_ops.prompts.instruction import LIFECYCLE_OPS_INSTRUCTION


def _ctx(state):
    return types.SimpleNamespace(state=state)


def test_base_instruction_for_english():
    assert build_lifecycle_ops_instruction(_ctx({})) == LIFECYCLE_OPS_INSTRUCTION


def test_non_english_prepends_directive():
    out = build_lifecycle_ops_instruction(_ctx({"locale": "de"}))
    assert out.startswith("RESPOND IN German")


def test_names_the_journey_the_operator_is_on():
    out = build_lifecycle_ops_instruction(_ctx({"journeyId": "lcj_1", "connectionId": "pcn_1"}))
    assert "lcj_1" in out and "pcn_1" in out


def test_drafts_only_and_catalog_only():
    text = LIFECYCLE_OPS_INSTRUCTION.lower()
    assert "drafts only" in text
    assert "never publish" in text
    assert "only what it returns" in text
    assert "never invent" in text
    assert '"default"' in LIFECYCLE_OPS_INSTRUCTION  # conditions need a default edge
    for token in ("{{block.checklist}}", "{{block.next_step}}", "{{block.insight}}", "{{user.first_name|there}}"):
        assert token in LIFECYCLE_OPS_INSTRUCTION
