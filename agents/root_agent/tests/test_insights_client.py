"""Unit tests for the Insights tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import insights_client as ic


def test_fetches_the_summary_with_the_session_token(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps({"signups": {"thisWeek": 76, "lastWeek": 68}, "sources": {"note": "estimated"}})

    monkeypatch.setattr(ic, "_get", fake)
    out = ic.get_summary({"ctxToken": "tok"})
    assert out["status"] == "success"
    assert out["signups"] == {"thisWeek": 76, "lastWeek": 68}
    assert seen == {"url": "https://app.example.com/api/agent/insights/summary", "token": "tok"}


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(ic, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert ic.get_summary({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert ic.get_summary({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (0, {"error": "network_error"}, "network_error"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(ic, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = ic.get_summary({"ctxToken": "tok"})
        assert out["status"] == "error" and out["code"] == code and out["message"]


def test_root_answers_performance_questions_from_the_tool():
    assert "get_insights_summary" in ROOT_SYSTEM_INSTRUCTION
    assert "answer only from its numbers" in ROOT_SYSTEM_INSTRUCTION
