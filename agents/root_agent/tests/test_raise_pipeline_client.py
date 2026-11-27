"""Unit tests for get_raise_pipeline's client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.sub_agents.lifecycle_ops.tools import raise_pipeline_client as rp

# A made-up board, counts only, as the app answers it.
_BOARD = {
    "status": "success",
    "setUp": True,
    "board": "Investors",
    "today": "2026-11-26",
    "pipelinePeople": 31,
    "stages": [{"name": "Contacted", "stage": "contacted", "role": "in play", "stagePeople": 11}],
    "passes": {
        "passedPeople": 5,
        "reasons": [{"reason": "crowded", "name": "Crowded market", "area": "Market", "reasonPasses": 3}],
        "ownReasons": [{"name": "Wants a lead first", "reasonPasses": 1}],
        "noReasonPasses": 1,
    },
    "followUps": {"quietAfterDays": 14, "quietPeople": 5, "nextStepPastPeople": 2, "overduePeople": 6},
    "capped": False,
    "meanings": {"overduePeople": {"means": "each person once"}},
    "note": "Counts only, from People's board.",
}


def test_reads_the_board_with_the_session_token_and_sends_nothing_else(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps(_BOARD)

    monkeypatch.setattr(rp, "_get", fake)
    state = {"ctxToken": "tok"}
    out = rp.get_raise_pipeline(state)
    assert out["status"] == "success"
    assert out["followUps"]["overduePeople"] == 6 and out["passes"]["reasons"][0]["reason"] == "crowded"
    assert seen == {"url": "https://app.example.com/api/agent/raise/pipeline", "token": "tok"}
    assert state["raisePipelineEnabled"] is True


def test_relays_a_board_that_isnt_set_up(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    note = "This brand has no investor or funding board yet."
    monkeypatch.setattr(rp, "_get", lambda *_: (200, json.dumps({"status": "success", "setUp": False, "note": note})))
    out = rp.get_raise_pipeline({"ctxToken": "tok"})
    assert out == {"status": "success", "setUp": False, "note": note}


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(rp, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert rp.get_raise_pipeline({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert rp.get_raise_pipeline({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (503, {"error": "canvas_auth_unconfigured"}, "canvas_auth_unconfigured"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (0, {"error": "network_error"}, "network_error"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(rp, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = rp.get_raise_pipeline({"ctxToken": "tok"})
        assert out["status"] == "error" and out["code"] == code and out["message"]
        if code in rp._ERRORS:
            assert out["message"] == rp._ERRORS[code]
    # Plain words, no dashes as punctuation.
    for message in rp._ERRORS.values():
        assert "—" not in message and "–" not in message and " - " not in message


def test_writes_whether_the_board_is_switched_on(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    state = {"ctxToken": "tok", "raisePipelineEnabled": True}
    monkeypatch.setattr(rp, "_get", lambda *_: (503, json.dumps({"error": "unavailable"})))
    rp.get_raise_pipeline(state)
    assert state["raisePipelineEnabled"] is False
    monkeypatch.setattr(rp, "_get", lambda *_: (200, json.dumps(_BOARD)))
    rp.get_raise_pipeline(state)
    assert state["raisePipelineEnabled"] is True
    # A busy hour says nothing about the switch.
    monkeypatch.setattr(rp, "_get", lambda *_: (429, json.dumps({"error": "rate_limited"})))
    rp.get_raise_pipeline(state)
    assert state["raisePipelineEnabled"] is True


def test_root_sends_board_questions_to_lifecycle_ops_and_never_a_name():
    text = ROOT_SYSTEM_INSTRUCTION
    assert "**investor or funding board**" in text
    assert "`get_raise_pipeline`" in text
    assert "never a name" in text
    # Right after the saved views line.
    assert text.index("get_view_counts") < text.index("get_raise_pipeline")
