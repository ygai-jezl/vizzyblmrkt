"""Unit tests for the usage tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import usage_client as uc

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=uc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(uc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_usage_with_the_session_token(monkeypatch):
    row = {"key": "web_searches", "label": "Web searches for research", "usedThisMonth": 140, "monthlyLimit": 1500, "leftThisMonth": 1360}
    calls = _capture(monkeypatch, 200, {"thisBrand": [row], "meanings": {"usedThisMonth": {"name": "Used this month"}}})
    out = uc.get_usage(STATE)
    assert out["status"] == "success" and out["thisBrand"][0]["leftThisMonth"] == 1360
    assert calls[0]["url"] == "https://app.example.com/api/agent/usage"
    assert calls[0]["token"] == "tok"
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert uc.get_usage(STATE) == {"status": "error", "code": "unavailable", "message": uc._ERRORS["unavailable"]}
    _capture(monkeypatch, 429, {"error": "rate_limited"})
    assert uc.get_usage(STATE)["code"] == "rate_limited"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert uc.get_usage(STATE)["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_usage" in ROOT_SYSTEM_INSTRUCTION
