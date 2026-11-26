"""Unit tests for the content strategy tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import content_strategy_client as cs

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=cs._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(cs, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_plan_with_the_session_token(monkeypatch):
    body = {
        "approved": {"at": "2026-11-26"},
        "nextWeeks": [{"week": "2026-W49", "action": "combine", "title": "AI visibility tracking"}],
        "meanings": {"slotCount": {"name": "Slots"}},
    }
    calls = _capture(monkeypatch, 200, body)
    out = cs.get_content_strategy(STATE)
    assert out["status"] == "success" and out["nextWeeks"][0]["action"] == "combine"
    assert "slotCount" in out["meanings"]
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/content-strategy", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert cs.get_content_strategy(STATE) == {"status": "error", "code": "unavailable", "message": cs._OFF}
    _capture(monkeypatch, 500, {})
    assert cs.get_content_strategy(STATE)["code"] == "http_500"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert cs.get_content_strategy(STATE)["code"] == "not_connected"
    assert cs.get_content_strategy({})["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_content_strategy" in ROOT_SYSTEM_INSTRUCTION
