"""Unit tests for the brand strategy tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import brand_strategy_client as bs

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=bs._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(bs, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_strategy_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"approved": {"at": "2026-11-25"}, "claims": [{"text": "Tracks 8 AI engines", "shownAs": "docs"}]})
    out = bs.get_brand_strategy(STATE)
    assert out["status"] == "success" and out["claims"][0]["shownAs"] == "docs"
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/brand-strategy", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert bs.get_brand_strategy(STATE) == {"status": "error", "code": "unavailable", "message": bs._OFF}
    _capture(monkeypatch, 500, {})
    assert bs.get_brand_strategy(STATE)["code"] == "http_500"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert bs.get_brand_strategy(STATE)["code"] == "not_connected"
    assert bs.get_brand_strategy({})["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_brand_strategy" in ROOT_SYSTEM_INSTRUCTION
