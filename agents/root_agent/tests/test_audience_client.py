"""Unit tests for the audience counts tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import audience_client as ac


def test_fetches_the_counts_with_the_session_token(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps({"people": 120, "canEmail": 96, "products": [{"name": "App", "people": 80, "stages": {"stuck": 7}}]})

    monkeypatch.setattr(ac, "_get", fake)
    out = ac.get_counts({"ctxToken": "tok"})
    assert out["status"] == "success"
    assert out["people"] == 120 and out["products"][0]["stages"] == {"stuck": 7}
    assert seen == {"url": "https://app.example.com/api/agent/audience/counts", "token": "tok"}


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(ac, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert ac.get_counts({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert ac.get_counts({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (0, {"error": "network_error"}, "network_error"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(ac, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = ac.get_counts({"ctxToken": "tok"})
        assert out["status"] == "error" and out["code"] == code and out["message"]


def test_root_counts_the_audience_and_no_longer_promises_signup_actions():
    assert "get_audience_counts" in ROOT_SYSTEM_INSTRUCTION
    assert "answer only from its counts" in ROOT_SYSTEM_INSTRUCTION
    # While the one view is off the tool says so, and Vizzy falls back to the Insights numbers.
    assert "answer from `get_insights_summary` instead" in ROOT_SYSTEM_INSTRUCTION
    assert "review and action signups" not in ROOT_SYSTEM_INSTRUCTION
    assert "actioning signups" not in ROOT_SYSTEM_INSTRUCTION


def test_messages_fit_the_area_whether_it_is_called_audience_or_people(monkeypatch):
    # NEXT_PUBLIC_NAV_PEOPLE_ENABLED renames Audience to People in the app; Vizzy can't read it.
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    texts = list(ac._ERRORS.values()) + [ac.get_counts({})["message"]]
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    texts.append(ac.get_counts({"ctxToken": "tok"})["message"])
    for text in texts:
        assert "Audience" not in text, text
    assert "in Audience" not in ROOT_SYSTEM_INSTRUCTION
    assert "**Audience**" not in ROOT_SYSTEM_INSTRUCTION


def test_lists_and_counts_saved_views_with_the_session_token(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps({"views": [{"name": "Wholesale, ordered lately"}], "counts": [{"name": "Wholesale, ordered lately", "viewPeople": 46, "capped": False}]})

    monkeypatch.setattr(ac, "_get", fake)
    out = ac.get_view_counts({"ctxToken": "tok"}, ["Wholesale, ordered lately", " ", "Next repot due"])
    assert out["status"] == "success" and out["counts"][0]["viewPeople"] == 46
    assert seen == {
        "url": "https://app.example.com/api/agent/audience/views?count=Wholesale%2C+ordered+lately&count=Next+repot+due",
        "token": "tok",
    }
    ac.get_view_counts({"ctxToken": "tok"})
    assert seen["url"] == "https://app.example.com/api/agent/audience/views"


def test_saved_view_errors_become_plain_messages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert ac.get_view_counts({}, ["x"])["status"] == "unavailable"
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(ac, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = ac.get_view_counts({"ctxToken": "tok"}, ["x"])
        assert out["status"] == "error" and out["code"] == code and out["message"]
    assert "switched on" in ac._VIEW_ERRORS["unavailable"]


def test_root_reads_saved_view_counts_and_never_changes_views():
    assert "get_view_counts" in ROOT_SYSTEM_INSTRUCTION
    assert 'say "at least" when `capped` is true' in ROOT_SYSTEM_INSTRUCTION
    assert "you never make, change or save a view" in ROOT_SYSTEM_INSTRUCTION
