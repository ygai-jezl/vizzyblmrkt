"""Unit tests for the audience counts tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import audience_client as ac


def test_fetches_the_counts_with_the_session_token(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps({"people": 120, "canEmail": 96, "products": [{"name": "App", "people": 80, "stages": {"stuck": 7}}]})

    monkeypatch.setattr(ac, "_get", fake)
    out = ac.get_counts({"ctxToken": "tok"})
    assert out["status"] == "success"
    assert out["people"] == 120 and out["products"][0]["stages"] == {"stuck": 7}
    assert seen == {"url": "https://app.example.com/api/agent/audience/counts", "token": "tok"}


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(ac, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert ac.get_counts({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert ac.get_counts({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (0, {"error": "network_error"}, "network_error"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(ac, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = ac.get_counts({"ctxToken": "tok"})
        assert out["status"] == "error" and out["code"] == code and out["message"]


def test_root_counts_the_audience_and_no_longer_promises_signup_actions():
    assert "get_audience_counts" in ROOT_SYSTEM_INSTRUCTION
    assert "answer only from its counts" in ROOT_SYSTEM_INSTRUCTION
    # While the one view is off the tool says so, and Vizzy falls back to the Insights numbers.
    assert "answer from `get_insights_summary` instead" in ROOT_SYSTEM_INSTRUCTION
    assert "review and action signups" not in ROOT_SYSTEM_INSTRUCTION
    assert "actioning signups" not in ROOT_SYSTEM_INSTRUCTION
