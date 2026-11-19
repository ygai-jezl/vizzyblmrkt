"""Unit tests for the Next up tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import next_up_client as nu

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=nu._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(nu, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_next_up_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"picks": [{"question": "How do I get cited?", "because": "No page of yours ranks."}]})
    out = nu.get_next_up(STATE)
    assert out["status"] == "success" and out["picks"][0]["question"] == "How do I get cited?"
    assert calls[0]["url"] == "https://app.example.com/api/agent/next-up"
    assert calls[0]["token"] == "tok"
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 403, {"error": "not_included"})
    assert nu.get_next_up(STATE) == {"status": "error", "code": "not_included", "message": nu._ERRORS["not_included"]}
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert nu.get_next_up(STATE)["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_next_up" in ROOT_SYSTEM_INSTRUCTION
