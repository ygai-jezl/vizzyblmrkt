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


def test_root_routes_content_to_content_ops():
    assert "content_ops_agent" in ROOT_SYSTEM_INSTRUCTION
