"""Unit tests for the learning tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import learning_client as lc

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=lc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(lc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_last_90_days_with_the_session_token_by_default(monkeypatch):
    body = {"days": 90, "kinds": [{"kind": "image_style", "label": "Image style", "line": "learns", "counts": {"made": 20}}], "moreKinds": 70}
    calls = _capture(monkeypatch, 200, body)
    out = lc.get_learning(STATE)
    assert out["status"] == "success" and out["days"] == 90 and out["kinds"][0]["label"] == "Image style"
    # No query: the app's own default of 90 days and the kinds made in them, for the token's brand.
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/learning", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_asks_for_kinds_by_name_all_kinds_and_days(monkeypatch):
    calls = _capture(monkeypatch, 200, {"kinds": []})
    lc.get_learning(STATE, kinds=["Edit mode", "post_image", "Edit mode", ""], days=30)
    assert calls[0]["url"] == "https://app.example.com/api/agent/learning?kinds=Edit+mode%2Cpost_image&days=30"
    lc.get_learning(STATE, all_kinds=True, days=1000)
    assert calls[1]["url"] == "https://app.example.com/api/agent/learning?all=1&days=182"
    # A comma inside a name never splits it, and at most 20 names go.
    lc.get_learning(STATE, kinds=["Writing, posts"] + [f"k{i}" for i in range(30)], days=2)
    url = calls[2]["url"]
    assert url.startswith("https://app.example.com/api/agent/learning?kinds=Writing+posts%2Ck0") and url.endswith("&days=7")
    assert url.count("%2C") == 19
    # Neither a truthy string nor a bool counts as all kinds or days.
    lc.get_learning(STATE, all_kinds="yes", days=True)  # type: ignore[arg-type]
    assert calls[3]["url"] == "https://app.example.com/api/agent/learning"


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert lc.get_learning(STATE) == {"status": "error", "code": "unavailable", "message": lc._OFF}
    _capture(monkeypatch, 429, {"error": "rate_limited"})
    assert lc.get_learning(STATE)["code"] == "rate_limited"
    _capture(monkeypatch, 500, {})
    assert lc.get_learning(STATE)["code"] == "http_500"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert lc.get_learning(STATE)["code"] == "not_connected"
    assert lc.get_learning({})["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it():
    assert "get_learning" in ROOT_SYSTEM_INSTRUCTION


def test_messages_keep_house_style():
    for text in [lc._OFF, lc._NO_LINK, *lc._ERRORS.values()]:
        assert "—" not in text and "–" not in text and " - " not in text
