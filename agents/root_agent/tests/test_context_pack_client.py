"""Unit tests for the context pack tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import context_pack_client as cp

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=cp._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(cp, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_a_map_question_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"map": [{"text": "Subject: Share of voice."}], "meanings": {"googlePosition": {"name": "Google position"}}})
    out = cp.get_brand_context(STATE, question_id="q_abc123")
    assert out["status"] == "success" and out["meanings"]["googlePosition"]["name"] == "Google position"
    assert calls[0]["url"] == "https://app.example.com/api/agent/context-pack?question=q_abc123"
    assert calls[0]["token"] == "tok"


def test_reads_a_question_in_words(monkeypatch):
    calls = _capture(monkeypatch)
    cp.get_brand_context(STATE, text="  How do agencies   report share of voice? ")
    assert calls[0]["url"].endswith("/api/agent/context-pack?text=How+do+agencies+report+share+of+voice%3F")


def test_asks_for_a_question_before_calling_and_never_sends_a_brand(monkeypatch):
    calls = _capture(monkeypatch)
    assert cp.get_brand_context(STATE)["code"] == "ask_required"
    assert cp.get_brand_context(STATE, question_id="q_1/../x")["code"] == "ask_required"
    assert calls == []
    cp.get_brand_context(STATE, subject_id="sub_1")
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    out = cp.get_brand_context(STATE, question_id="q_1")
    assert out == {"status": "error", "code": "unavailable", "message": cp._ERRORS["unavailable"]}
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert cp.get_brand_context(STATE, question_id="q_1")["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_brand_context" in ROOT_SYSTEM_INSTRUCTION
