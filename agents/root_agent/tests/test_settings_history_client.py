"""Unit tests for the settings history tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import settings_history_client as sh

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, timeout=sh._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(sh, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_history_with_the_session_token(monkeypatch):
    body = {"entries": [{"kind": "journeys", "subject": "journey:lcj_1", "version": 5, "by": "Sam Okafor", "live": True}], "next": None}
    calls = _capture(monkeypatch, 200, body)
    out = sh.get_settings_history(STATE)
    assert out["status"] == "success" and out["entries"][0]["by"] == "Sam Okafor"
    assert calls[0] == {"method": "GET", "url": "https://app.example.com/api/agent/settings-history", "token": "tok"}
    assert "tenant" not in calls[0]["url"]


def test_asks_for_a_kind_a_subject_one_version_and_the_next_page(monkeypatch):
    calls = _capture(monkeypatch, 200, {"document": {}})
    sh.get_settings_history(STATE, kind="journeys", subject="journey:lcj_1", version=3, cursor="abc")
    assert calls[0]["url"] == "https://app.example.com/api/agent/settings-history?kind=journeys&subject=journey%3Alcj_1&rev=3&cursor=abc"
    # A version means nothing without its subject, and an unknown kind is left out.
    sh.get_settings_history(STATE, kind="people", version=3)
    assert calls[1]["url"] == "https://app.example.com/api/agent/settings-history"
    # Team views are a kind, and their setting a subject.
    sh.get_settings_history(STATE, kind="views", subject="views:person", version=2)
    assert calls[2]["url"] == "https://app.example.com/api/agent/settings-history?kind=views&subject=views%3Aperson&rev=2"


def test_passes_errors_on_in_plain_words(monkeypatch):
    _capture(monkeypatch, 404, {"error": "not_found"})
    assert sh.get_settings_history(STATE) == {"status": "error", "code": "not_found", "message": sh._OFF}
    _capture(monkeypatch, 500, {})
    assert sh.get_settings_history(STATE)["code"] == "http_500"
    # Reading one version whole: read only and missing versions never say history is off.
    for status, code in ((409, "journey_archived"), (409, "connection_revoked"), (404, "kind_not_shown"), (404, "version_not_found")):
        _capture(monkeypatch, status, {"error": code})
        out = sh.get_settings_history(STATE, subject="journey:lcj_1", version=2)
        assert out["code"] == code and out["message"] == sh._ERRORS[code] and out["message"] != sh._OFF
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert sh.get_settings_history(STATE)["code"] == "not_connected"
    assert sh.get_settings_history({})["code"] == "not_connected"


def test_vizzy_is_told_when_to_use_it_and_that_it_never_restores():
    assert "get_settings_history" in ROOT_SYSTEM_INSTRUCTION
    line = next(l for l in ROOT_SYSTEM_INSTRUCTION.splitlines() if "get_settings_history" in l)
    assert "never restore" in line
