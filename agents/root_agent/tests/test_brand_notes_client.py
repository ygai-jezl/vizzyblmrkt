"""Unit tests for the What we've seen tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import brand_notes_client as bn

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None, timeout=bn._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(bn, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_notes_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"total": 2, "fewest": ["disagree"]})
    assert bn.get_notes(STATE) == {"status": "success", "total": 2, "fewest": ["disagree"]}
    assert calls[0]["url"] == "https://app.example.com/api/agent/brand-notes" and calls[0]["token"] == "tok"
    bn.get_notes(STATE, "checking every day")
    assert calls[1]["url"].endswith("/api/agent/brand-notes?find=checking%20every%20day")


def test_files_notes_in_the_words_given(monkeypatch):
    calls = _capture(monkeypatch, 200, {"filed": 2, "message": "Filed 2 suggested notes."})
    r = bn.suggest(STATE, ["tested | We ran it daily for a week.", "Buyers ask why they can't check by hand.", "  ", "short"])
    assert r["status"] == "success" and r["filed"] == 2
    assert calls[0]["payload"] == {
        "notes": [{"kind": "tested", "text": "We ran it daily for a week."}, {"text": "Buyers ask why they can't check by hand."}]
    }
    assert r["unread"] == ['"short" is too short to be a note']


def test_says_why_nothing_was_filed(monkeypatch):
    calls = _capture(monkeypatch)
    assert bn.suggest(STATE, [])["code"] == "nothing_to_file"
    assert bn.suggest(STATE, [f"Note number {i} with enough words." for i in range(6)])["code"] == "too_many"
    assert calls == []


def test_relays_the_apps_errors_plainly(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert bn.suggest(STATE, ["We ran it daily for a week."])["message"] == bn._OFF
    _capture(monkeypatch, 400, {"error": "invalid_input", "issues": ["notes.0.text: too short"]})
    assert "too short" in bn.suggest(STATE, ["We ran it daily for a week."])["message"]
    assert bn.get_notes({})["code"] == "not_connected"


def test_vizzy_is_told_to_use_the_persons_words_and_ask_one_question_at_a_time():
    assert "get_brand_notes" in ROOT_SYSTEM_INSTRUCTION and "suggest_brand_notes" in ROOT_SYSTEM_INSTRUCTION
    assert "one question at a time" in ROOT_SYSTEM_INSTRUCTION
    assert "never invent" in ROOT_SYSTEM_INSTRUCTION.lower()
