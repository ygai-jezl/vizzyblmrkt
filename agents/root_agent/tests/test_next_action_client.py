"""Unit tests for the Your next action tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import next_action_client as na

STATE = {"ctxToken": "tok", "tenantId": "ten_A", "userId": "usr_1"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=na._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(na, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_card_with_the_session_token_only(monkeypatch):
    card = {"status": "card", "upToDate": True, "card": {"steps": [{"n": 1, "title": "Start your first email list", "kind": "ask_vizzy"}]}, "recent": []}
    calls = _capture(monkeypatch, 200, card)
    out = na.get_next_action(STATE)
    assert out == {"status": "success", **card}
    assert calls == [{"method": "GET", "url": "https://app.example.com/api/agent/next-action", "token": "tok"}]
    # Nothing tenant-like ever goes in a request: the brand comes from the token.
    assert "ten_A" not in calls[0]["url"] and "usr_1" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert na.get_next_action(STATE) == {"status": "error", "code": "unavailable", "message": na._OFF}
    _capture(monkeypatch, 403, {"error": "admins_only"})
    assert na.get_next_action(STATE)["message"].startswith("Only an admin can read Your next action")
    _capture(monkeypatch, 500, "not json")
    assert na.get_next_action(STATE)["code"] == "http_500"
    _capture(monkeypatch, 0, {"error": "network_error"})
    assert na.get_next_action(STATE)["code"] == "network_error"


def test_needs_the_session_and_the_app(monkeypatch):
    calls = _capture(monkeypatch)
    assert na.get_next_action({})["code"] == "not_connected"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert na.get_next_action(STATE)["code"] == "not_connected"
    assert calls == []


def test_the_words_it_says_keep_house_style():
    for message in [*na._ERRORS.values(), na._OFF, na._NO_LINK]:
        assert "\u2014" not in message and "\u2013" not in message and " - " not in message


def test_the_instruction_says_when_to_read_it_and_that_vizzy_only_reads():
    assert "get_next_action" in ROOT_SYSTEM_INSTRUCTION
    assert "never say you did" in ROOT_SYSTEM_INSTRUCTION
