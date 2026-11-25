"""Unit tests for the review_article tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import article_review_client as rc

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, body_=None, timeout=rc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token, "body": body_})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(rc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_starts_or_moves_a_review_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"articleId": "plan_123", "review": {"state": "running", "now": "opening its sources"}})
    out = rc.review_article(STATE, "plan_123")
    assert out["status"] == "success" and out["review"]["state"] == "running"
    assert calls[0] == {"method": "POST", "url": "https://app.example.com/api/agent/article-review", "token": "tok", "body": {"articleId": "plan_123"}}


def test_only_looks_when_asked_to(monkeypatch):
    calls = _capture(monkeypatch, 200, {"review": None})
    rc.review_article(STATE, "plan_123", move_on=False)
    assert calls[0]["method"] == "GET" and calls[0]["url"].endswith("/api/agent/article-review?articleId=plan_123")
    assert calls[0]["body"] is None


def test_refuses_an_id_that_isnt_one_and_passes_errors_on_in_plain_words(monkeypatch):
    calls = _capture(monkeypatch, 200, {})
    assert rc.review_article(STATE, "../../x")["code"] == "invalid_input"
    assert calls == []
    _capture(monkeypatch, 429, {"error": "monthly_limit"})
    assert rc.review_article(STATE, "plan_123") == {"status": "error", "code": "monthly_limit", "message": rc._ERRORS["monthly_limit"]}
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert rc.review_article(STATE, "plan_123")["message"] == rc._ERRORS["unavailable"]
    assert rc.review_article({}, "plan_123")["code"] == "not_connected"


def test_the_prompt_says_it_never_applies():
    assert "call `review_article` with its `articleId`" in ROOT_SYSTEM_INSTRUCTION
    assert "You never apply or dismiss a change" in ROOT_SYSTEM_INSTRUCTION
