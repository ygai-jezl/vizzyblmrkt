"""Unit tests for the results tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import results_client as rc

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=rc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(rc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_email_results_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"scope": "overview", "meanings": {"sends": {"name": "Sends"}}})
    out = rc.get_email_results(STATE)
    assert out["status"] == "success" and out["meanings"]["sends"]["name"] == "Sends"
    assert calls[0]["url"] == "https://app.example.com/api/agent/results/email?scope=overview"
    assert calls[0]["token"] == "tok"
    rc.get_email_results(STATE, "journey", "lcj_1")
    assert calls[1]["url"].endswith("/api/agent/results/email?scope=journey&id=lcj_1")


def test_asks_for_an_id_before_calling_and_never_sends_a_brand(monkeypatch):
    calls = _capture(monkeypatch)
    assert rc.get_email_results(STATE, "launch", "")["code"] == "id_required"
    assert rc.get_email_results(STATE, "journey", "a/b")["code"] == "id_required"
    assert calls == []
    rc.get_email_results(STATE, "people")
    assert "tenant" not in calls[0]["url"] and calls[0]["url"].endswith("scope=overview")


def test_reads_post_results_with_a_bounded_period(monkeypatch):
    calls = _capture(monkeypatch)
    rc.get_post_results(STATE)
    assert calls[0]["url"].endswith("/api/agent/results/posts?days=30")
    rc.get_post_results(STATE, "x", 9999, " p1 ")
    assert calls[1]["url"].endswith("/api/agent/results/posts?channel=x&days=365&post=p1")
    rc.get_post_results(STATE, "instagram", "soon")
    assert calls[2]["url"].endswith("/api/agent/results/posts?days=30")


def test_relays_the_apps_errors_plainly(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert rc.get_post_results(STATE)["message"] == rc._OFF
    _capture(monkeypatch, 404, {"error": "not_found"})
    assert rc.get_email_results(STATE, "journey", "lcj_9")["message"] == "I couldn't find that waitlist or journey."
    assert rc.get_email_results({})["code"] == "not_connected"


def test_the_instruction_routes_results_questions_and_uses_meanings():
    assert "get_email_results" in ROOT_SYSTEM_INSTRUCTION
    assert "get_post_results" in ROOT_SYSTEM_INSTRUCTION
    assert "meanings" in ROOT_SYSTEM_INSTRUCTION
