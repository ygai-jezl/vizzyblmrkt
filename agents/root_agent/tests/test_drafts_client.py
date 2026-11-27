"""Unit tests for the get_drafts tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import drafts_client as dc

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=dc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(dc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_record_with_the_session_token(monkeypatch):
    body = {"made": 6, "waiting": 3, "kept": 2, "keptAfterEdits": 1, "dismissed": 1, "kinds": []}
    calls = _capture(monkeypatch, 200, body)
    out = dc.get_drafts(STATE)
    assert out["status"] == "success" and out["made"] == 6
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/drafts", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_asks_for_one_kind_and_at_most_90_days(monkeypatch):
    calls = _capture(monkeypatch, 200, {})
    dc.get_drafts(STATE, kind="lifecycle_journey", days=14)
    assert calls[0]["url"] == "https://app.example.com/api/agent/drafts?kind=lifecycle_journey&days=14"
    dc.get_drafts(STATE, kind="people", days=365)
    assert calls[1]["url"] == "https://app.example.com/api/agent/drafts?days=90"
    dc.get_drafts(STATE, days=0)
    assert calls[2]["url"] == "https://app.example.com/api/agent/drafts"


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "agent_record_disabled"})
    assert dc.get_drafts(STATE) == {"status": "error", "code": "agent_record_disabled", "message": dc._OFF}
    _capture(monkeypatch, 403, {"error": "admins_only"})
    assert dc.get_drafts(STATE, kind="brand_note")["message"] == dc._ERRORS["admins_only"]
    _capture(monkeypatch, 500, {})
    assert dc.get_drafts(STATE)["code"] == "http_500"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert dc.get_drafts(STATE)["code"] == "not_connected"
    assert dc.get_drafts({})["code"] == "not_connected"


def test_the_kinds_match_the_app_and_the_prompt_says_when_to_call_it():
    assert len(dc.KINDS) == 12
    assert "`get_drafts`" in ROOT_SYSTEM_INSTRUCTION
    assert "older drafts aren't in it" in ROOT_SYSTEM_INSTRUCTION


def test_messages_keep_to_house_style():
    for text in [dc._OFF, dc._NO_LINK, *dc._ERRORS.values()]:
        assert chr(0x2014) not in text and chr(0x2013) not in text and " - " not in text
