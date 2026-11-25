"""Unit tests for the articles due tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import articles_due_client as ac

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=ac._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(ac, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_due_articles_with_the_session_token(monkeypatch):
    article = {"title": "Share of voice, explained", "state": "due a refresh", "clockDays": 20, "reasons": ["21 days since its last update or check, on a 20-day clock"]}
    calls = _capture(monkeypatch, 200, {"articles": [article], "articlesDue": 1, "meanings": {"articlesDue": {"name": "Articles due a refresh"}}})
    out = ac.list_articles_due(STATE)
    assert out["status"] == "success" and out["articles"][0]["clockDays"] == 20
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/articles-due", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert ac.list_articles_due(STATE) == {"status": "error", "code": "unavailable", "message": ac._ERRORS["unavailable"]}
    _capture(monkeypatch, 401, {"error": "unauthorized"})
    assert ac.list_articles_due(STATE)["code"] == "unauthorized"
    _capture(monkeypatch, 500, {})
    assert ac.list_articles_due(STATE)["code"] == "http_500"
    assert ac.list_articles_due({})["code"] == "not_connected"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert ac.list_articles_due(STATE)["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "list_articles_due" in ROOT_SYSTEM_INSTRUCTION
    assert "never say you refreshed or checked one" in ROOT_SYSTEM_INSTRUCTION
