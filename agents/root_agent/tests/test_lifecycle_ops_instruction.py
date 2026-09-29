"""Unit tests for the Lifecycle Ops instruction (pure helper, no ADK needed)."""

from __future__ import annotations

import json
import types

from root_agent_pkg.sub_agents.lifecycle_ops.instruction_builder import build_lifecycle_ops_instruction
from root_agent_pkg.sub_agents.lifecycle_ops.prompts.instruction import (
    EMAIL_STYLE_ADDENDUM,
    EMAIL_STYLE_BRAND_LOOK,
    EMAIL_STYLE_JOURNEY_LOOK,
    JOURNEY_STYLE_ADDENDUM,
    LIFECYCLE_OPS_INSTRUCTION,
)
from root_agent_pkg.sub_agents.lifecycle_ops.tools import lifecycle_client as lc
from root_agent_pkg.tools import journey_style_client as js


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


def test_repo_learning_is_read_only_and_human_accepted():
    text = LIFECYCLE_OPS_INSTRUCTION
    assert "learn_product_from_repo" in text and "get_repo_analysis" in text
    assert "only READS the code" in text
    assert "never say or imply we change it" in text
    assert "cannot accept items into the catalog yourself" in text


def test_email_style_rule_only_when_a_style_is_saved():
    assert build_lifecycle_ops_instruction(_ctx({})) == LIFECYCLE_OPS_INSTRUCTION
    assert build_lifecycle_ops_instruction(_ctx({"emailStyleConfigured": False})) == LIFECYCLE_OPS_INSTRUCTION
    out = build_lifecycle_ops_instruction(_ctx({"emailStyleConfigured": True}))
    assert out == LIFECYCLE_OPS_INSTRUCTION + "\n\n" + EMAIL_STYLE_ADDENDUM
    assert EMAIL_STYLE_ADDENDUM.startswith("# Email style")
    assert "no colours, images, logos, headers or buttons of your own" in EMAIL_STYLE_ADDENDUM


def test_every_context_read_rewrites_the_email_style_flag(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    state = {"ctxToken": "tok", "emailStyleConfigured": True}
    replies = iter([{"connections": []}, {"emailStyle": {"configured": True}}, {"emailStyle": {"configured": False}}])
    monkeypatch.setattr(lc, "_request", lambda *_a, **_k: (200, json.dumps(next(replies))))

    # A flag-off context has no emailStyle key, so a stale True from earlier goes.
    lc.get_context(state)
    assert state["emailStyleConfigured"] is False
    assert build_lifecycle_ops_instruction(_ctx(state)) == LIFECYCLE_OPS_INSTRUCTION
    lc.get_context(state)
    assert state["emailStyleConfigured"] is True
    lc.get_context(state)
    assert state["emailStyleConfigured"] is False



# The "This conversation" block on a product journey's page, as it was before journey styles.
PRODUCT_PAGE = (
    LIFECYCLE_OPS_INSTRUCTION
    + "\n\n# This conversation\n"
    + "The operator is on the page of journey lcj_1 (connected product pcn_1). Requests to change "
    + '"this journey" mean that one: read it with get_lifecycle_journey before editing.'
)


def test_journey_styles_off_leave_a_product_journey_page_as_it_was():
    page = {"journeyId": "lcj_1", "connectionId": "pcn_1"}
    assert build_lifecycle_ops_instruction(_ctx(page)) == PRODUCT_PAGE
    assert build_lifecycle_ops_instruction(_ctx({**page, "journeyStyleEnabled": False})) == PRODUCT_PAGE
    styled = {**page, "emailStyleConfigured": True}
    assert build_lifecycle_ops_instruction(_ctx({**styled, "journeyStyleEnabled": False})) == (
        PRODUCT_PAGE + "\n\n" + EMAIL_STYLE_ADDENDUM
    )


def test_the_journey_style_rule_shows_with_or_without_a_brand_style():
    assert build_lifecycle_ops_instruction(_ctx({"journeyStyleEnabled": True})) == (
        LIFECYCLE_OPS_INSTRUCTION + "\n\n" + JOURNEY_STYLE_ADDENDUM
    )
    out = build_lifecycle_ops_instruction(_ctx({"journeyId": "lcj_1", "connectionId": "pcn_1", "journeyStyleEnabled": True}))
    assert out == PRODUCT_PAGE + "\n\n" + JOURNEY_STYLE_ADDENDUM
    assert JOURNEY_STYLE_ADDENDUM.startswith("# A journey's own look")
    for words in ("get_journey_email_style", "set_journey_email_style", 'mode "custom"', '"brand"', "DRAFT"):
        assert words in JOURNEY_STYLE_ADDENDUM
    assert "never say it's\nlive" in JOURNEY_STYLE_ADDENDUM


def test_with_both_the_email_style_rule_names_the_journey_tool():
    # The swap has something to replace: the addendum ends with the brand-only sentence.
    assert EMAIL_STYLE_ADDENDUM.endswith(EMAIL_STYLE_BRAND_LOOK)
    out = build_lifecycle_ops_instruction(_ctx({"emailStyleConfigured": True, "journeyStyleEnabled": True}))
    swapped = EMAIL_STYLE_ADDENDUM[: -len(EMAIL_STYLE_BRAND_LOOK)] + EMAIL_STYLE_JOURNEY_LOOK
    assert out == LIFECYCLE_OPS_INSTRUCTION + "\n\n" + swapped + "\n\n" + JOURNEY_STYLE_ADDENDUM
    assert "not a journey edit" not in out
    assert "set_journey_email_style (see below)" in swapped


def test_a_launch_welcome_journey_page_points_to_the_style_tools():
    for state in ({"journeyId": "lcjw_abc123"}, {"journeyId": "lcjw_abc123", "journeyStyleEnabled": True}):
        out = build_lifecycle_ops_instruction(_ctx(state))
        conversation = out.split("# This conversation\n", 1)[1]
        assert conversation.startswith("The operator is on the page of journey lcjw_abc123, a launch's welcome journey.")
        assert "get_journey_email_style and set_journey_email_style" in conversation
        assert "can't open a launch's journey, so don't call them for it" in conversation
        assert "read it with get_lifecycle_journey before editing" not in out
        assert "connected product" not in conversation


def test_every_context_read_rewrites_the_journey_style_flag(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    state = {"ctxToken": "tok", "journeyStyleEnabled": True}
    replies = iter(
        [
            (200, {"connections": []}),
            (200, {"journeyStyle": {"enabled": True}}),
            (401, {"error": "unauthorized"}),
            (200, {"journeyStyle": "yes"}),
            (0, {"error": "network_error"}),
        ]
    )

    def reply(*_a, **_k):
        status, body = next(replies)
        return status, json.dumps(body)

    monkeypatch.setattr(lc, "_request", reply)

    # A flag-off context has no journeyStyle key, so a stale True from earlier goes.
    lc.get_context(state)
    assert state["journeyStyleEnabled"] is False
    lc.get_context(state)
    assert state["journeyStyleEnabled"] is True
    assert JOURNEY_STYLE_ADDENDUM in build_lifecycle_ops_instruction(_ctx(state))
    # An error leaves it as it was.
    assert lc.get_context(state)["status"] == "error"
    assert state["journeyStyleEnabled"] is True
    lc.get_context(state)
    assert state["journeyStyleEnabled"] is False
    assert lc.get_context(state)["status"] == "error"
    assert state["journeyStyleEnabled"] is False
    assert build_lifecycle_ops_instruction(_ctx(state)) == LIFECYCLE_OPS_INSTRUCTION


def test_the_journey_style_read_sets_the_flag_too(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    state = {"ctxToken": "tok", "journeyId": "lcj_1", "connectionId": "pcn_1"}
    monkeypatch.setattr(js, "_request", lambda *_a, **_k: (200, json.dumps({"canEdit": True})))
    js.get_style(state)
    assert build_lifecycle_ops_instruction(_ctx(state)) == PRODUCT_PAGE + "\n\n" + JOURNEY_STYLE_ADDENDUM
    monkeypatch.setattr(js, "_request", lambda *_a, **_k: (503, json.dumps({"error": "unavailable"})))
    js.get_style(state)
    assert build_lifecycle_ops_instruction(_ctx(state)) == PRODUCT_PAGE
